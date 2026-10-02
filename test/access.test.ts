// Phase 3: API tokens and read-only phone access. Includes the Q-10 adversarial cases: code
// replay, expiry, redeeming without approval or from another device, approving someone else's
// pairing, cross-workspace codes, and a read-only session trying every kind of write.
import { describe, expect, it, beforeAll } from "vitest";
import { appSql, makeApp, createWorkspace, addUser, Client, setupApProject, type TestWorkspace } from "./helpers.ts";
import type { RateLimiter } from "../src/worker/http.ts";

const sql = appSql();
let allowed = Infinity;
const limiter: RateLimiter = { limit: async () => allowed-- > 0 };
const { app } = makeApp(sql, { rateLimits: { api: limiter } });

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

let ws: TestWorkspace;
let admin: Client;
let recordTypeId: string;
let recordKey: string;

beforeAll(async () => {
  ws = await createWorkspace(sql);
  admin = await new Client(app).signIn(ws.admin.email, ws.slug);
  ({ recordTypeId } = await setupApProject(admin, "TOK"));
  const r = await admin.post("/api/records", { recordTypeId, title: "Token test", custom: { vendor: "Acme" } });
  recordKey = r.json.record.key;
});

function bearer(secret: string) {
  return { authorization: `Bearer ${secret}` };
}

describe("API tokens", () => {
  it("creates a token whose secret is shown once and acts as its owner within its scopes", async () => {
    const agent = await addUser(sql, ws, "agent");
    const c = await new Client(app).signIn(agent.email, ws.slug);
    const created = await c.post("/api/tokens", { name: "Reporting", scopes: ["records:read", "config:read"], expiresInDays: 30 });
    expect(created.status).toBe(201);
    expect(created.json.secret).toMatch(new RegExp(`^t247\\.${ws.id}\\.[A-Za-z0-9_-]{43}$`));
    const list = await c.get("/api/tokens");
    expect(list.json.tokens).toHaveLength(1);
    expect(JSON.stringify(list.json)).not.toContain(created.json.secret.split(".")[2]);
    expect(list.json.tokens[0].hint).toBe(created.json.secret.split(".")[2].slice(0, 6));

    const api = new Client(app);
    const h = bearer(created.json.secret);
    expect((await api.req("GET", "/api/me", undefined, h)).json.id).toBe(agent.id);
    expect((await api.req("GET", "/api/records", undefined, h)).json.items.length).toBeGreaterThan(0);
    expect((await api.req("GET", `/api/records/${recordKey}`, undefined, h)).status).toBe(200);
    const write = await api.req("POST", "/api/records", { recordTypeId, title: "x", custom: { vendor: "V" } }, h);
    expect(write.status).toBe(403);
    expect(write.json.error.details.scope).toBe("records:write");
    // Routes tokens may never use, whatever the scope.
    for (const [m, p] of [["GET", "/api/notifications"], ["GET", "/api/views"], ["GET", "/api/tokens"], ["POST", "/api/tokens"], ["GET", "/api/admin/users"], ["POST", "/api/devices/pair"], ["POST", "/auth/logout"]]) {
      const r = await api.req(m!, p!, m === "POST" ? {} : undefined, h);
      expect({ p, status: r.status }).toEqual({ p, status: 403 });
    }
    const lastUsed = await c.get("/api/tokens");
    expect(lastUsed.json.tokens[0].lastUsedAt).not.toBeNull();
  });

  it("a write token creates records marked as coming from the API", async () => {
    const created = await admin.post("/api/tokens", { name: "Sync", scopes: ["records:write", "records:read", "comments:write"] });
    const h = bearer(created.json.secret);
    const api = new Client(app);
    const r = await api.req("POST", "/api/records", { recordTypeId, title: "From the ERP", custom: { vendor: "Acme" } }, h);
    expect(r.status).toBe(201);
    expect(r.json.record.via).toBe("api");
    const cm = await api.req("POST", `/api/records/${r.json.record.key}/comments`, { body: "Synced", internal: false }, h);
    expect(cm.status).toBe(201);
    // Admin role does not unlock admin routes for tokens.
    expect((await api.req("GET", "/api/admin/settings", undefined, h)).status).toBe(403);
  });

  it("refuses revoked, expired, malformed and cross-workspace tokens, and inactive owners", async () => {
    const other = await createWorkspace(sql, "Other");
    const created = await admin.post("/api/tokens", { name: "Short-lived", scopes: ["records:read"] });
    const secret: string = created.json.secret;
    const api = new Client(app);
    expect((await api.req("GET", "/api/me", undefined, bearer(secret))).status).toBe(200);
    // Same secret presented for another workspace.
    expect((await api.req("GET", "/api/me", undefined, bearer(secret.replace(ws.id, other.id)))).status).toBe(401);
    expect((await api.req("GET", "/api/me", undefined, { authorization: "Bearer nope" })).status).toBe(401);
    expect((await api.req("GET", "/api/me", undefined, { authorization: "Basic abc" })).status).toBe(401);
    await sql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${ws.id}, true)`;
      await tx`update api_tokens set expires_at = now() - interval '1 minute' where id = ${created.json.token.id}`;
    });
    expect((await api.req("GET", "/api/me", undefined, bearer(secret))).status).toBe(401);

    const second = await admin.post("/api/tokens", { name: "Revoke me", scopes: ["records:read"] });
    expect((await admin.delete(`/api/tokens/${second.json.token.id}`)).status).toBe(200);
    expect((await api.req("GET", "/api/me", undefined, bearer(second.json.secret))).status).toBe(401);

    const agent = await addUser(sql, ws, "agent");
    const c = await new Client(app).signIn(agent.email, ws.slug);
    const third = await c.post("/api/tokens", { name: "Leaver", scopes: ["records:read"] });
    await admin.patch(`/api/admin/users/${agent.id}`, { active: false });
    expect((await api.req("GET", "/api/me", undefined, bearer(third.json.secret))).status).toBe(401);
  });

  it("a bad token never falls back to the session cookie", async () => {
    const r = await admin.req("GET", "/api/me", undefined, { authorization: "Bearer t247.bogus" });
    expect(r.status).toBe(401);
  });

  it("requesters cannot create tokens; agents see only their own; admins can see all", async () => {
    const requester = await addUser(sql, ws, "requester");
    const rc = await new Client(app).signIn(requester.email, ws.slug);
    expect((await rc.post("/api/tokens", { name: "x", scopes: ["records:read"] })).status).toBe(403);
    const agent = await addUser(sql, ws, "agent");
    const ac = await new Client(app).signIn(agent.email, ws.slug);
    await ac.post("/api/tokens", { name: "mine", scopes: ["records:read"] });
    expect((await ac.get("/api/tokens?all=1")).json.tokens.map((t: { name: string }) => t.name)).toEqual(["mine"]);
    const all = await admin.get("/api/tokens?all=1");
    expect(all.json.tokens.some((t: { name: string }) => t.name === "mine")).toBe(true);
    // An agent cannot revoke someone else's token.
    const adminToken = all.json.tokens.find((t: { userId: string; revokedAt: string | null }) => t.userId === ws.admin.id && !t.revokedAt);
    expect((await ac.delete(`/api/tokens/${adminToken.id}`)).status).toBe(404);
  });

  it("rate limits each token", async () => {
    const created = await admin.post("/api/tokens", { name: "Busy", scopes: ["records:read"] });
    const api = new Client(app);
    allowed = 2;
    expect((await api.req("GET", "/api/me", undefined, bearer(created.json.secret))).status).toBe(200);
    expect((await api.req("GET", "/api/me", undefined, bearer(created.json.secret))).status).toBe(200);
    expect((await api.req("GET", "/api/me", undefined, bearer(created.json.secret))).status).toBe(429);
    allowed = Infinity;
  });
});

describe("read-only phone access (QR pairing)", () => {
  async function pair(desktop: Client) {
    const start = await desktop.post("/api/devices/pair");
    expect(start.status).toBe(201);
    const fragment = new URL(start.json.url).hash.slice(1);
    expect(new URL(start.json.url).pathname).toBe("/auth/pair");
    const code = new URLSearchParams(fragment).get("c")!;
    return { id: start.json.id as string, code };
  }

  it("pairs a phone after desktop approval, as the same person, read-only, for at most 4 hours", async () => {
    const page = await new Client(app).raw("/auth/pair");
    expect(page.headers.get("content-security-policy")).toMatch(/script-src 'nonce-/);

    const { id, code } = await pair(admin);
    const phone = new Client(app);
    const claim = await phone.req("POST", "/auth/pair/claim", { code }, { "user-agent": IPHONE });
    expect(claim.status).toBe(200);
    expect(claim.json.deviceLabel).toBe("iPhone · Safari");
    const waiting = await admin.get(`/api/devices/pair/${id}`);
    expect(waiting.json.pairing).toMatchObject({ status: "claimed", deviceLabel: "iPhone · Safari", matchNumber: claim.json.matchNumber });
    expect((await phone.post("/auth/pair/status")).json.status).toBe("claimed");
    expect((await phone.post("/auth/pair/redeem")).status).toBe(403); // not approved yet

    expect((await admin.post(`/api/devices/pair/${id}/approve`)).status).toBe(200);
    expect((await phone.post("/auth/pair/status")).json.status).toBe("approved");
    const redeemed = await phone.post("/auth/pair/redeem");
    expect(redeemed.status).toBe(200);
    expect(Date.parse(redeemed.json.expiresAt) - Date.now()).toBeLessThanOrEqual(4 * 3600_000 + 5000);
    const me = await phone.get("/api/me");
    expect(me.json.id).toBe(ws.admin.id);
    expect((await phone.get(`/api/records/${recordKey}`)).status).toBe(200);
    expect((await phone.get(`/api/records/${recordKey}/comments`)).status).toBe(200);

    // A second redeem with the same claim fails.
    expect((await phone.post("/auth/pair/redeem")).status).toBe(403);

    const devices = await admin.get("/api/devices");
    expect(devices.json.devices).toHaveLength(1);
    const audit = await admin.get("/api/admin/audit?limit=20");
    const actions = audit.json.entries.filter((e: { entity: string }) => e.entity === "device").map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["pair_requested", "pair_claimed", "pair_approved", "paired"]));
  });

  it("a read-only session cannot write, administer, pair or mint tokens", async () => {
    const { id, code } = await pair(admin);
    const phone = new Client(app);
    await phone.req("POST", "/auth/pair/claim", { code }, { "user-agent": IPHONE });
    await admin.post(`/api/devices/pair/${id}/approve`);
    await phone.post("/auth/pair/redeem");
    const attempts: [string, string, unknown?][] = [
      ["POST", "/api/records", { recordTypeId, title: "x", custom: { vendor: "V" } }],
      ["PATCH", `/api/records/${recordKey}`, { version: 1, title: "x" }],
      ["DELETE", `/api/records/${recordKey}`],
      ["POST", `/api/records/${recordKey}/comments`, { body: "x" }],
      ["POST", `/api/records/${recordKey}/transitions`, { transition: "start" }],
      ["POST", "/api/records/bulk", { ids: [], patch: {} }],
      ["POST", "/api/notifications/read", { all: true }],
      ["GET", `/api/records/${recordKey}/events`],
      ["GET", "/api/views"],
      ["GET", "/api/admin/users"],
      ["PATCH", "/api/admin/settings", { trashRetentionDays: 1 }],
      ["GET", "/api/tokens"],
      ["POST", "/api/tokens", { name: "x", scopes: ["records:read"] }],
      ["POST", "/api/devices/pair", {}],
      ["GET", "/api/devices"],
      ["POST", "/api/approvals/00000000-0000-0000-0000-000000000000/decision", { decision: "approve" }],
      ["POST", "/api/demo/persona", { persona: "admin" }],
    ];
    for (const [m, p, body] of attempts) {
      const r = await phone.req(m, p, body);
      expect({ m, p, status: r.status }).toEqual({ m, p, status: 403 });
    }
    // Percent-encoded paths reach the same routes; the check must see what the router sees.
    for (const [m, p, body] of [
      ["GET", "/%61pi/admin/users"],
      ["POST", "/%61pi/records", { recordTypeId, title: "x", custom: { vendor: "V" } }],
      ["PATCH", "/%61pi/admin/settings", { trashRetentionDays: 1 }],
      ["POST", "/%61pi/tokens", { name: "x", scopes: ["records:write"] }],
      ["POST", "/api/%74okens", { name: "x", scopes: ["records:write"] }],
      ["POST", "/%61uth/dev", { email: ws.admin.email, workspace: ws.slug }],
    ] as [string, string, unknown?][]) {
      const r = await phone.req(m, p, body);
      expect({ m, p, status: r.status }).toEqual({ m, p, status: 403 });
    }
    const upload = await phone.upload(`/api/records/${recordKey}/attachments`, new Uint8Array([1, 2, 3]), "x.bin");
    expect(upload.status).toBe(403);
    expect((await phone.post("/auth/logout")).status).toBe(200);
  });

  it("codes are single-use, expire, and only work in their own workspace", async () => {
    const { code } = await pair(admin);
    const first = new Client(app);
    expect((await first.req("POST", "/auth/pair/claim", { code }, { "user-agent": IPHONE })).status).toBe(200);
    expect((await new Client(app).post("/auth/pair/claim", { code })).status).toBe(400);

    const other = await createWorkspace(sql, "Elsewhere");
    const second = await pair(admin);
    const [, secret] = second.code.split(".");
    expect((await new Client(app).post("/auth/pair/claim", { code: `${other.id}.${secret}` })).status).toBe(400);

    const third = await pair(admin);
    await sql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${ws.id}, true)`;
      await tx`update device_pairings set expires_at = now() - interval '1 second' where id = ${third.id}`;
    });
    expect((await new Client(app).post("/auth/pair/claim", { code: third.code })).status).toBe(400);
    expect((await admin.get(`/api/devices/pair/${third.id}`)).json.pairing.status).toBe("expired");
    expect((await new Client(app).post("/auth/pair/claim", { code: "garbage" })).status).toBe(400);
  });

  it("only the claiming phone can redeem, only the owner can approve, and denial sticks", async () => {
    const { id, code } = await pair(admin);
    const phone = new Client(app);
    await phone.req("POST", "/auth/pair/claim", { code }, { "user-agent": IPHONE });
    const otherAdmin = await addUser(sql, ws, "admin");
    const oc = await new Client(app).signIn(otherAdmin.email, ws.slug);
    expect((await oc.post(`/api/devices/pair/${id}/approve`)).status).toBe(409);
    expect((await oc.get(`/api/devices/pair/${id}`)).status).toBe(404);
    expect((await admin.post(`/api/devices/pair/${id}/approve`)).status).toBe(200);
    // Another device without the claim cookie cannot redeem the approval.
    const thief = new Client(app);
    expect((await thief.post("/auth/pair/redeem")).status).toBe(403);
    thief.cookie = "t247_pair=" + `${ws.id}.${id}.${"A".repeat(43)}`;
    expect((await thief.post("/auth/pair/redeem")).status).toBe(403);
    expect((await phone.post("/auth/pair/redeem")).status).toBe(200);

    const next = await pair(admin);
    const phone2 = new Client(app);
    await phone2.req("POST", "/auth/pair/claim", { code: next.code }, { "user-agent": IPHONE });
    expect((await admin.post(`/api/devices/pair/${next.id}/deny`)).status).toBe(200);
    expect((await phone2.post("/auth/pair/status")).json.status).toBe("denied");
    expect((await phone2.post("/auth/pair/redeem")).status).toBe(403);
    expect((await admin.post(`/api/devices/pair/${next.id}/approve`)).status).toBe(409);
  });

  it("revoking a linked device signs the phone out at once", async () => {
    const { id, code } = await pair(admin);
    const phone = new Client(app);
    await phone.req("POST", "/auth/pair/claim", { code }, { "user-agent": IPHONE });
    await admin.post(`/api/devices/pair/${id}/approve`);
    await phone.post("/auth/pair/redeem");
    expect((await phone.get("/api/me")).status).toBe(200);
    expect((await admin.delete(`/api/devices/${id}`)).status).toBe(200);
    expect((await phone.get("/api/me")).status).toBe(401);
    const audit = await admin.get("/api/admin/audit?limit=5");
    expect(audit.json.entries.some((e: { entity: string; action: string }) => e.entity === "device" && e.action === "revoked")).toBe(true);
  });

  it("API tokens cannot pair devices", async () => {
    const created = await admin.post("/api/tokens", { name: "x", scopes: ["records:read"] });
    const r = await new Client(app).req("POST", "/api/devices/pair", {}, bearer(created.json.secret));
    expect(r.status).toBe(403);
  });
});
