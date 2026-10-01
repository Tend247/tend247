import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import type { AppEnv, Ctx } from "../http.ts";
import { isSecure, originOf, readJson, requireAuth, runAfterResponse, sessionCookieName } from "../http.ts";
import { withTenant, type Tx } from "../db/client.ts";
import { resolveWorkspace, type Workspace } from "../auth/workspaces.ts";
import { createSession, destroySession } from "../auth/sessions.ts";
import { finishOidc, startOidc, type OidcIdentity } from "../auth/oidc.ts";
import type { OidcConfig } from "../config.ts";
import { findUserByEmail, insertUser } from "../users/service.ts";
import { AppError, invalid } from "../lib/errors.ts";
import { decideByToken, peekApprovalToken } from "../approvals/service.ts";
import { processTenantOutbox, workerDeps } from "../jobs/runner.ts";
import { isUuid, randomToken, sha256Hex, signPayload, verifyPayload } from "../lib/crypto.ts";

const OIDC_COOKIE = "t247_oidc";
const MAGIC_LINK_MINUTES = 15;

async function startSession(c: Ctx, tenantId: string, userId: string): Promise<void> {
  const { config } = c.get("deps");
  const { cookieValue, expiresAt } = await withTenant(c.get("sql"), tenantId, (tx) =>
    createSession(tx, { tenantId, userId, ttlHours: config.sessionTtlHours }),
  );
  setCookie(c, sessionCookieName(c), cookieValue, {
    httpOnly: true,
    secure: isSecure(c),
    sameSite: "Lax",
    path: "/",
    expires: expiresAt,
  });
}

const emailBody = z.object({
  email: z.string().trim().toLowerCase().email(),
  workspace: z.string().trim().optional(),
});
const verifyBody = z.object({ w: z.string(), t: z.string().min(20).max(128) });

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw invalid(r.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })));
  return r.data;
}

const domainOf = (email: string) => email.split("@")[1] ?? "";

/** Who may receive an email sign-in link. Staff use single sign-on whenever it is configured. */
function mayUseEmailLink(c: Ctx, role: string): boolean {
  return !c.get("deps").config.oidc || role === "requester";
}

// The emailed link carries the token in the URL fragment, which browsers never send to the
// server, so it stays out of request logs and Referer headers. This page reads it, removes it
// from history and redeems it with a POST, so link scanners that only fetch the URL cannot
// use the link up.
const MAGIC_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signing in · Tend 24/7</title><style>body{font-family:system-ui,sans-serif;background:#101317;color:#e7e9ec;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:26rem;padding:2rem;text-align:center}button{font:inherit;font-weight:700;padding:.8rem 1.4rem;border-radius:8px;border:0;background:#f2a33a;color:#1c1206;cursor:pointer}p{color:#9aa3ae}</style></head>
<body><main><h1>Sign in to Tend 24/7</h1><p id="msg">Continue to finish signing in on this device.</p><button id="go">Continue</button></main>
<script>
const p=new URLSearchParams(location.hash.slice(1));const w=p.get("w"),t=p.get("t");history.replaceState(null,"",location.pathname);
const msg=document.getElementById("msg"),go=document.getElementById("go");
if(!w||!t){msg.textContent="This sign-in link is incomplete. Request a new one.";go.remove();}
go&&go.addEventListener("click",async()=>{go.disabled=true;const r=await fetch("/auth/magic/verify",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({w,t})});
if(r.ok){location.replace("/app");}else{msg.textContent="That link has expired or was already used. Request a new one.";go.remove();}});
</script></body></html>`;

// Emailed approval links work the same way: the one-time token stays in the fragment, and the
// decision is a POST from this page, so a mail scanner opening the link decides nothing.
const APPROVAL_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Approval · Tend 24/7</title><style>body{font-family:system-ui,sans-serif;background:#101317;color:#e7e9ec;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:30rem;padding:2rem}h1{font-size:1.4rem}p{color:#9aa3ae}textarea{width:100%;box-sizing:border-box;min-height:5rem;background:#181c22;color:inherit;border:1px solid #2b313a;border-radius:8px;padding:.6rem;font:inherit}.row{display:flex;gap:.6rem;margin-top:1rem}button{font:inherit;font-weight:700;padding:.75rem 1.2rem;border-radius:8px;border:0;cursor:pointer}#ok{background:#f2a33a;color:#1c1206}#no{background:#2b313a;color:#e7e9ec}</style></head>
<body><main><h1 id="title">Approval request</h1><p id="msg">Loading…</p><div id="form" hidden><textarea id="note" placeholder="Note (optional)" maxlength="5000"></textarea>
<div class="row"><button id="ok">Approve</button><button id="no">Reject</button></div></div></main>
<script>
const token=location.hash.slice(1);history.replaceState(null,"",location.pathname);
const $=(id)=>document.getElementById(id);
const post=(path,body)=>fetch(path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
(async()=>{if(!token){$("msg").textContent="This approval link is incomplete.";return;}
const r=await post("/auth/approval/peek",{token});if(!r.ok){$("msg").textContent="This link has expired or was already used. Open Tend 24/7 to see the request.";return;}
const d=await r.json();$("title").textContent=d.record.key+": "+d.record.title;
if(d.status!=="pending"){$("msg").textContent="This request has already been decided.";return;}
$("msg").textContent=(d.requestedByName||"Someone")+" asks you to approve \u201c"+d.transitionName+"\u201d.";$("form").hidden=false;
const decide=async(decision)=>{$("ok").disabled=$("no").disabled=true;const note=$("note").value.trim();
const res=await post("/auth/approval/decide",{token,decision,...(note?{comment:note}:{})});$("form").hidden=true;
$("msg").textContent=res.ok?(decision==="approve"?"Approved. Thank you.":"Rejected. Thank you."):"That did not work: the link may have expired or the request was already decided.";};
$("ok").onclick=()=>decide("approve");$("no").onclick=()=>decide("reject");})();
</script></body></html>`;

const tokenBody = z.object({ token: z.string().min(40).max(200) });
const decideBody = z.object({
  token: z.string().min(40).max(200),
  decision: z.enum(["approve", "reject"]),
  comment: z.string().trim().min(1).max(5000).optional(),
});

export const authRoutes = new Hono<AppEnv>()
  /** What the sign-in page should offer. */
  .get("/config", async (c) => {
    const { config, email } = c.get("deps");
    const ws = await resolveWorkspace(c.get("sql"), c.req.query("workspace"));
    return c.json({
      workspace: ws ? { slug: ws.slug, name: ws.name, demo: ws.demo } : null,
      devLogin: config.devLogin,
      oidc: Boolean(config.oidc),
      magicLinks: email.canDeliver,
      publicSite: config.publicSite,
      repoUrl: config.repoUrl,
    });
  })

  /** Local development only: sign in as an existing user without a password. */
  .post("/dev", async (c) => {
    const { config } = c.get("deps");
    if (!config.devLogin) throw new AppError("not_found", "Not found");
    const { email, workspace } = parse(emailBody, await readJson(c));
    const ws = await resolveWorkspace(c.get("sql"), workspace);
    if (!ws) throw new AppError("not_found", "Workspace not found");
    const user = await withTenant(c.get("sql"), ws.id, (tx) => findUserByEmail(tx, email));
    if (!user || !user.active) throw new AppError("not_found", "No active user with that email");
    await startSession(c, ws.id, user.id);
    return c.json({ ok: true });
  })

  /**
   * Email a one-time sign-in link. Always answers 202, and does the lookup and sending after
   * the response, so neither the answer nor its timing reveals who has an account.
   */
  .post("/magic", async (c) => {
    const { config, email: mailer } = c.get("deps");
    if (!mailer.canDeliver) throw new AppError("not_found", "Email sign-in is not available");
    const { email, workspace } = parse(emailBody, await readJson(c));
    const origin = originOf(c, config);
    const sql = c.get("sql");
    await runAfterResponse(
      c,
      (async () => {
        const ws = await resolveWorkspace(sql, workspace);
        if (!ws) return;
        const token = randomToken(32);
        const hash = await sha256Hex(token);
        const issued = await withTenant(sql, ws.id, async (tx) => {
          const user = await findUserByEmail(tx, email);
          let userId: string | null = null;
          if (user) {
            if (!user.active || !mayUseEmailLink(c, user.role)) return false;
            userId = user.id;
          } else if (!config.requesterDomains.includes(domainOf(email))) {
            return false;
          }
          await tx`
            insert into magic_links (token_hash, tenant_id, user_id, email, expires_at)
            values (${hash}, ${ws.id}, ${userId}, ${email}, now() + make_interval(mins => ${MAGIC_LINK_MINUTES}))`;
          return true;
        });
        if (!issued) return;
        await mailer.send({
          to: email,
          subject: `Your sign-in link for ${ws.name}`,
          text: `Use this link to sign in to Tend 24/7 (${ws.name}). It works once and expires in ${MAGIC_LINK_MINUTES} minutes.\n\n${origin}/auth/magic#w=${ws.id}&t=${token}\n\nIf you did not ask for this, ignore this email.`,
        });
      })(),
    );
    return c.json({ ok: true }, 202);
  })

  .get("/magic", (c) => c.html(MAGIC_PAGE))

  /** Redeem a sign-in link (POSTed by the page above). Creates a self-registered requester on first use. */
  .post("/magic/verify", async (c) => {
    const { config } = c.get("deps");
    const { w, t } = parse(verifyBody, await readJson(c));
    const expired = () => new AppError("bad_request", "That link has expired or was already used");
    if (!isUuid(w) || !/^[A-Za-z0-9_-]+$/.test(t)) throw expired();
    const [ws] = await c.get("sql")<Workspace[]>`
      select id, slug, name, demo, expires_at from tenants where id = ${w} and (expires_at is null or expires_at > now())`;
    if (!ws) throw expired();
    const hash = await sha256Hex(t);
    const userId = await withTenant(c.get("sql"), ws.id, async (tx) => {
      const [link] = await tx<{ userId: string | null; email: string }[]>`
        update magic_links set used_at = now()
        where token_hash = ${hash} and used_at is null and expires_at > now()
        returning user_id, email`;
      if (!link) return null;
      if (link.userId) {
        const [u] = await tx<{ id: string; role: string }[]>`select id, role from users where id = ${link.userId} and active`;
        return u && mayUseEmailLink(c, u.role) ? u.id : null;
      }
      const existing = await findUserByEmail(tx, link.email);
      if (existing) return existing.active && mayUseEmailLink(c, existing.role) ? existing.id : null;
      if (!config.requesterDomains.includes(domainOf(link.email))) return null;
      const created = await insertUser(tx, ws.id, {
        email: link.email,
        displayName: link.email.split("@")[0]!.slice(0, 200),
        role: "requester",
      });
      return created.id;
    });
    if (!userId) throw expired();
    await startSession(c, ws.id, userId);
    return c.json({ ok: true });
  })

  .get("/oidc/start", async (c) => {
    const { config, oidcFetch } = c.get("deps");
    if (!config.oidc) throw new AppError("not_found", "Single sign-on is not configured");
    const ws = await resolveWorkspace(c.get("sql"), c.req.query("workspace"));
    if (!ws) throw new AppError("not_found", "Workspace not found");
    const redirectUri = `${originOf(c, config)}/auth/oidc/callback`;
    const start = await startOidc(config.oidc, redirectUri, oidcFetch);
    const cookie = await signPayload(config.sessionSecret, {
      s: start.state,
      n: start.nonce,
      v: start.codeVerifier,
      w: ws.id,
      exp: Date.now() + 10 * 60_000,
    });
    setCookie(c, OIDC_COOKIE, cookie, {
      httpOnly: true,
      secure: isSecure(c),
      sameSite: "Lax",
      path: "/auth/oidc",
      maxAge: 600,
    });
    return c.redirect(start.url);
  })

  .get("/oidc/callback", async (c) => {
    const { config, oidcFetch } = c.get("deps");
    if (!config.oidc) throw new AppError("not_found", "Single sign-on is not configured");
    const oidc = config.oidc;
    const pending = await verifyPayload<{ s: string; n: string; v: string; w: string; exp: number }>(
      config.sessionSecret,
      getCookie(c, OIDC_COOKIE),
    );
    deleteCookie(c, OIDC_COOKIE, { path: "/auth/oidc" });
    if (!pending || pending.exp < Date.now() || !isUuid(pending.w)) return c.redirect("/signin?error=sso_expired");
    try {
      const identity = await finishOidc(
        oidc,
        {
          currentUrl: new URL(c.req.url),
          redirectUri: `${originOf(c, config)}/auth/oidc/callback`,
          state: pending.s,
          nonce: pending.n,
          codeVerifier: pending.v,
        },
        oidcFetch,
      );
      const [ws] = await c.get("sql")<Workspace[]>`
        select id, slug, name, demo, expires_at from tenants
        where id = ${pending.w} and (expires_at is null or expires_at > now())`;
      if (!ws) return c.redirect("/signin?error=sso_expired");
      const userId = await withTenant(c.get("sql"), ws.id, (tx) => matchOidcUser(tx, ws, oidc, identity));
      if (!userId) return c.redirect("/signin?error=not_invited");
      await startSession(c, ws.id, userId);
      return c.redirect("/app");
    } catch (err) {
      console.warn("OIDC sign-in failed:", (err as Error).message);
      return c.redirect("/signin?error=sso_failed");
    }
  })

  .get("/approval", (c) => c.html(APPROVAL_PAGE))
  .post("/approval/peek", async (c) => {
    const { token } = parse(tokenBody, await readJson(c));
    return c.json(await peekApprovalToken(c.get("sql"), token));
  })
  .post("/approval/decide", async (c) => {
    const { token, ...decision } = parse(decideBody, await readJson(c));
    const approval = await decideByToken(c.get("sql"), token, decision);
    const tenantId = token.split(".")[0]!.toLowerCase();
    await runAfterResponse(c, processTenantOutbox(workerDeps(c.get("deps"), c.get("sql"), c), tenantId));
    return c.json({ status: approval.status });
  })

  .post("/logout", async (c) => {
    const auth = requireAuth(c);
    await destroySession(c.get("sql"), auth);
    deleteCookie(c, sessionCookieName(c), { path: "/", secure: isSecure(c) });
    return c.json({ ok: true });
  });

/**
 * Map a provider identity to a person:
 *  1. by OIDC subject (stable, set on first link);
 *  2. by email, only when the provider verified it (or the deployment explicitly trusts its
 *     single-tenant provider) and the domain is allowed; blocks "nOAuth"-style takeovers;
 *  3. new person, only with auto-provisioning on, a verified email in an allowed domain, and
 *     never into a demo workspace.
 */
async function matchOidcUser(tx: Tx, ws: Workspace, oidc: OidcConfig, id: OidcIdentity): Promise<string | null> {
  const [bySubject] = await tx<{ id: string; active: boolean }[]>`
    select id, active from users where oidc_subject = ${id.subject}`;
  if (bySubject) return bySubject.active ? bySubject.id : null;

  const domainOk = oidc.allowedDomains.length === 0 || oidc.allowedDomains.includes(domainOf(id.email));
  const emailTrusted = (id.emailVerified || oidc.trustUnverifiedEmail) && domainOk;
  const byEmail = await findUserByEmail(tx, id.email);
  if (byEmail) {
    if (!emailTrusted || !byEmail.active || byEmail.oidcSubject) return null;
    await tx`update users set oidc_subject = ${id.subject} where id = ${byEmail.id}`;
    return byEmail.id;
  }

  if (oidc.autoProvision === "off" || ws.demo || !id.emailVerified || oidc.allowedDomains.length === 0 || !domainOk) {
    return null;
  }
  const created = await insertUser(tx, ws.id, {
    email: id.email,
    displayName: id.name,
    role: oidc.autoProvision,
    oidcSubject: id.subject,
  });
  return created.id;
}
