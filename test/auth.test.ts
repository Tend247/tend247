import { beforeAll, describe, expect, it } from "vitest";
import { SignJWT, generateKeyPair } from "jose";
import { createHash } from "node:crypto";
import { createSql, withTenant } from "../src/worker/db/client.ts";
import { resetOidcCache } from "../src/worker/auth/oidc.ts";
import { DisabledEmailSender, MemoryEmailSender } from "../src/worker/email/sender.ts";
import { loadConfig, type OidcConfig } from "../src/worker/config.ts";
import { createApp } from "../src/worker/app.ts";
import { appSql, ownerSql, makeApp, createWorkspace, addUser, baseConfig, Client, type TestWorkspace } from "./helpers.ts";
import { SUPERUSER_URL } from "./setup/env.ts";

const sql = appSql();
let ws: TestWorkspace;

beforeAll(async () => {
  ws = await createWorkspace(sql);
});

function linkParts(text: string): { path: string; w: string; t: string } {
  const url = new URL(/https?:\/\/[^\s]+/.exec(text)![0]);
  const params = new URLSearchParams(url.hash.slice(1));
  return { path: url.pathname, w: params.get("w")!, t: params.get("t")! };
}

describe("dev login and sessions", () => {
  it("is unavailable unless enabled", async () => {
    const { app } = makeApp(sql, { config: { devLogin: false } });
    const r = await new Client(app).post("/auth/dev", { email: ws.admin.email, workspace: ws.slug });
    expect(r.status).toBe(404);
  });

  it("signs in, reports the user, and signs out", async () => {
    const { app } = makeApp(sql);
    const c = await new Client(app).signIn(ws.admin.email, ws.slug);
    const me = await c.get("/api/me");
    expect(me.json).toMatchObject({ email: ws.admin.email, role: "admin", workspaceId: ws.id });
    const stolen = c.cookie;
    expect((await c.post("/auth/logout")).status).toBe(200);
    const replay = new Client(app);
    replay.cookie = stolen;
    expect((await replay.get("/api/me")).status).toBe(401);
  });

  it("sets an HttpOnly, SameSite=Lax session cookie", async () => {
    const { app } = makeApp(sql);
    const r = await new Client(app).post("/auth/dev", { email: ws.admin.email, workspace: ws.slug });
    const sc = r.headers.getSetCookie().find((h) => h.startsWith("t247_session="))!;
    expect(sc).toMatch(/HttpOnly/);
    expect(sc).toMatch(/SameSite=Lax/);
  });

  it("uses the __Host- cookie prefix over HTTPS", async () => {
    const { app } = makeApp(sql);
    const res = await app.request("https://tend.example/auth/dev", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: ws.admin.email, workspace: ws.slug }),
    });
    const sc = res.headers.getSetCookie().find((h) => h.startsWith("__Host-t247_session="))!;
    expect(sc).toMatch(/Secure/);
    expect(sc).toMatch(/Path=\//);
  });

  it("ends sessions when their workspace expires", async () => {
    const temp = await createWorkspace(sql, "Temp sandbox");
    const { app } = makeApp(sql);
    const c = await new Client(app).signIn(temp.admin.email, temp.slug);
    expect((await c.get("/api/me")).status).toBe(200);
    await sql`update tenants set expires_at = now() - interval '1 minute' where id = ${temp.id}`;
    expect((await c.get("/api/me")).status).toBe(401);
  });
});

describe("cross-site request forgery", () => {
  it("requires exactly application/json for unsafe methods", async () => {
    const { app } = makeApp(sql);
    for (const type of ["application/x-www-form-urlencoded", "text/plain; x=application/json", "text/plain"]) {
      const res = await app.request("http://localhost/auth/dev", {
        method: "POST",
        headers: { "content-type": type },
        body: JSON.stringify({ email: ws.admin.email, workspace: ws.slug }),
      });
      expect({ type, status: res.status }).toEqual({ type, status: 415 });
    }
  });

  it("refuses requests the browser marks as cross-site", async () => {
    const { app } = makeApp(sql);
    const c = await new Client(app).signIn(ws.admin.email, ws.slug);
    const r = await c.req("POST", "/api/admin/projects", { key: "CSRF", name: "x" }, { "sec-fetch-site": "cross-site" });
    expect(r.status).toBe(403);
  });
});

describe("magic links", () => {
  it("emails a single-use link in the URL fragment; redeeming it signs a new requester in", async () => {
    const email = new MemoryEmailSender();
    const { app } = makeApp(sql, { email });
    const c = new Client(app);
    const r = await c.post("/auth/magic", { email: "Line.Lead@fernhollow.test", workspace: ws.slug });
    expect(r.status).toBe(202);
    expect(email.sent).toHaveLength(1);
    const { path, w, t } = linkParts(email.sent[0]!.text);
    expect(path).toBe("/auth/magic");
    // Requesting a link creates no account; redeeming it does.
    const before = await withTenant(sql, ws.id, (tx) => tx`select 1 from users where email = 'line.lead@fernhollow.test'`);
    expect(before.length).toBe(0);
    expect((await c.get("/auth/magic")).status).toBe(200); // the page that redeems the fragment
    const v = await c.post("/auth/magic/verify", { w, t });
    expect(v.status).toBe(200);
    expect((await c.get("/api/me")).json).toMatchObject({ email: "line.lead@fernhollow.test", role: "requester" });
    expect((await new Client(app).post("/auth/magic/verify", { w, t })).status).toBe(400);
  });

  it("answers the same for unknown addresses and sends nothing", async () => {
    const email = new MemoryEmailSender();
    const { app } = makeApp(sql, { email });
    const r = await new Client(app).post("/auth/magic", { email: "stranger@elsewhere.test", workspace: ws.slug });
    expect(r.status).toBe(202);
    expect(email.sent).toHaveLength(0);
  });

  it("does not email links to staff when single sign-on is configured", async () => {
    const email = new MemoryEmailSender();
    const { app } = makeApp(sql, {
      email,
      config: {
        oidc: { issuer: "https://idp.test", clientId: "x", clientSecret: "", autoProvision: "off", allowedDomains: [], trustUnverifiedEmail: false },
      },
    });
    expect((await new Client(app).post("/auth/magic", { email: ws.admin.email, workspace: ws.slug })).status).toBe(202);
    expect(email.sent).toHaveLength(0);
  });

  it("keeps the database client open until after-response work (sending the link) finishes", async () => {
    const order: string[] = [];
    const email = new MemoryEmailSender();
    const slowEmail = {
      name: "slow",
      canDeliver: true,
      async send(m: Parameters<MemoryEmailSender["send"]>[0]) {
        await new Promise((r) => setTimeout(r, 30));
        order.push("sent");
        await email.send(m);
      },
    };
    const waits: Promise<unknown>[] = [];
    const app = createApp({
      config: baseConfig,
      getSql: () => sql,
      email: slowEmail,
      releaseSql: (_c, _sql, pending) => {
        waits.push(pending.then(() => order.push("released")));
      },
    });
    const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p), passThroughOnException: () => {}, props: {} };
    const res = await app.request(
      "http://localhost/auth/magic",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: ws.admin.email, workspace: ws.slug }) },
      {},
      ctx as never,
    );
    expect(res.status).toBe(202);
    expect(order).toEqual([]); // answered before the work ran
    await Promise.all(waits);
    await Promise.all(waits);
    expect(order).toEqual(["sent", "released"]);
  });

  it("is switched off when no email sender can deliver", async () => {
    const app = createApp({ config: baseConfig, getSql: () => sql, email: new DisabledEmailSender() });
    const c = new Client(app);
    expect((await c.post("/auth/magic", { email: ws.admin.email, workspace: ws.slug })).status).toBe(404);
    expect((await c.get("/auth/config")).json.magicLinks).toBe(false);
  });
});

describe("OIDC single sign-on", () => {
  const ISSUER = "https://idp.fernhollow.test";
  const CLIENT_ID = "tend247";
  const codes = new Map<string, { challenge: string; nonce: string }>();
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  let claims: { sub: string; email: string; email_verified?: boolean; name?: string } = {
    sub: "okta|1001",
    email: "maria@fernhollow.test",
    email_verified: true,
    name: "Maria Lopez",
  };

  const fakeIdp: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : (input as Request).url ?? String(input));
    if (url.pathname === "/.well-known/openid-configuration") {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
      });
    }
    if (url.pathname === "/token") {
      const body = new URLSearchParams(String(init?.body ?? ""));
      const entry = codes.get(body.get("code") ?? "");
      const challenge = createHash("sha256").update(body.get("code_verifier") ?? "").digest("base64url");
      if (!entry || entry.challenge !== challenge) return Response.json({ error: "invalid_grant" }, { status: 400 });
      const { sub, ...rest } = claims;
      const idToken = await new SignJWT({ ...rest, nonce: entry.nonce })
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer(ISSUER)
        .setAudience(CLIENT_ID)
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(keys.privateKey);
      return Response.json({ access_token: "at", token_type: "Bearer", id_token: idToken });
    }
    return new Response("not found", { status: 404 });
  };

  const oidc = (over: Partial<OidcConfig> = {}): OidcConfig => ({
    issuer: ISSUER,
    clientId: CLIENT_ID,
    clientSecret: "s",
    autoProvision: "off",
    allowedDomains: ["fernhollow.test"],
    trustUnverifiedEmail: false,
    ...over,
  });

  beforeAll(async () => {
    keys = await generateKeyPair("RS256");
    resetOidcCache();
  });

  async function runFlow(over: Partial<OidcConfig> = {}, workspace = ws.slug) {
    const { app } = makeApp(sql, { config: { oidc: oidc(over) }, oidcFetch: fakeIdp });
    const c = new Client(app);
    const start = await c.get(`/auth/oidc/start?workspace=${workspace}`);
    expect(start.status).toBe(302);
    const authorize = new URL(start.headers.get("location")!);
    expect(authorize.origin + authorize.pathname).toBe(`${ISSUER}/authorize`);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    const code = `code-${Math.random()}`;
    codes.set(code, { challenge: authorize.searchParams.get("code_challenge")!, nonce: authorize.searchParams.get("nonce")! });
    const cb = await c.get(`/auth/oidc/callback?code=${encodeURIComponent(code)}&state=${authorize.searchParams.get("state")}`);
    return { c, location: cb.headers.get("location") };
  }

  it("refuses people who were not invited when auto-provisioning is off", async () => {
    expect((await runFlow()).location).toBe("/signin?error=not_invited");
  });

  it("provisions an agent on first sign-in with a verified email in an allowed domain", async () => {
    const { c, location } = await runFlow({ autoProvision: "agent" });
    expect(location).toBe("/app");
    expect((await c.get("/api/me")).json).toMatchObject({ email: "maria@fernhollow.test", role: "agent" });
  });

  it("signs in an existing user by subject even after their email changes", async () => {
    claims = { ...claims, email: "maria.lopez@fernhollow.test" };
    const { c, location } = await runFlow();
    expect(location).toBe("/app");
    expect((await c.get("/api/me")).json.email).toBe("maria@fernhollow.test");
  });

  it("never links an existing account by an unverified email (nOAuth)", async () => {
    claims = { sub: "attacker|1", email: ws.admin.email, name: "Not the admin" }; // no email_verified claim
    expect((await runFlow({ allowedDomains: [] })).location).toBe("/signin?error=not_invited");
    claims = { sub: "attacker|2", email: ws.admin.email, email_verified: false };
    expect((await runFlow({ allowedDomains: [] })).location).toBe("/signin?error=not_invited");
  });

  it("links by unverified email only when the deployment explicitly trusts its provider", async () => {
    const agent = await addUser(sql, ws, "agent", "entra.user@fernhollow.test");
    claims = { sub: "entra|77", email: agent.email, name: "Entra User" };
    const { c, location } = await runFlow({ trustUnverifiedEmail: true });
    expect(location).toBe("/app");
    expect((await c.get("/api/me")).json.email).toBe("entra.user@fernhollow.test");
  });

  it("does not provision outside the allowed domains", async () => {
    claims = { sub: "google|5", email: "someone@gmail.test", email_verified: true };
    expect((await runFlow({ autoProvision: "agent" })).location).toBe("/signin?error=not_invited");
  });

  it("survives a very long display name from the provider", async () => {
    claims = { sub: "okta|long", email: "long.name@fernhollow.test", email_verified: true, name: "x".repeat(500) };
    const { c, location } = await runFlow({ autoProvision: "requester" });
    expect(location).toBe("/app");
    expect((await c.get("/api/me")).json.displayName).toHaveLength(200);
  });

  it("rejects a callback with a tampered state", async () => {
    const { app } = makeApp(sql, { config: { oidc: oidc({ autoProvision: "agent" }) }, oidcFetch: fakeIdp });
    const c = new Client(app);
    await c.get(`/auth/oidc/start?workspace=${ws.slug}`);
    const cb = await c.get(`/auth/oidc/callback?code=x&state=forged`);
    expect(cb.headers.get("location")).toBe("/signin?error=sso_failed");
  });

  it("refuses auto-provisioning without allowed domains at configuration time", () => {
    const env = {
      TEND247_SESSION_SECRET: baseConfig.sessionSecret,
      TEND247_OIDC_ISSUER: ISSUER,
      TEND247_OIDC_CLIENT_ID: CLIENT_ID,
      TEND247_OIDC_AUTO_PROVISION: "agent",
    };
    expect(() => loadConfig(env)).toThrow(/ALLOWED_DOMAINS/);
    expect(loadConfig({ ...env, TEND247_OIDC_ALLOWED_DOMAINS: "fernhollow.test" }).oidc?.allowedDomains).toEqual([
      "fernhollow.test",
    ]);
  });
});

describe("database safety check", () => {
  it("refuses to serve when connected as the schema owner", async () => {
    const { app } = makeApp(ownerSql());
    const r = await new Client(app).get("/healthz");
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe("unsafe_database");
    expect(JSON.stringify(r.json)).not.toMatch(/tend247_owner/); // no internals for visitors
  });

  it("refuses to serve when connected as a role that bypasses row-level security", async () => {
    const su = createSql(SUPERUSER_URL, { max: 1 });
    try {
      await su`select 1`;
    } catch {
      await su.end();
      return; // no superuser available in this environment
    }
    const { app } = makeApp(su);
    const r = await new Client(app).get("/healthz");
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe("unsafe_database");
    await su.end();
  });
});
