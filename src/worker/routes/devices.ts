// Phone pairing: the desktop side (/api/devices) and the phone side (/auth/pair).
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv, Ctx } from "../http.ts";
import { isSecure, originOf, requireAuth, sessionCookieName } from "../http.ts";
import { withTenant, type Tx } from "../db/client.ts";
import type { AuthContext } from "../auth/sessions.ts";
import {
  claimPairing,
  claimStatus,
  decidePairing,
  getPairing,
  listDevices,
  redeemPairing,
  revokeDevice,
  startPairing,
} from "../devices/service.ts";
import { htmlPage, PAGE_STYLE } from "../lib/html.ts";
import { AppError } from "../lib/errors.ts";

const CLAIM_COOKIE = "t247_pair";

function asMe<T>(c: Ctx, fn: (tx: Tx, auth: AuthContext) => Promise<T>): Promise<T> {
  const auth = requireAuth(c);
  return withTenant(c.get("sql"), auth.tenantId, (tx) => fn(tx, auth));
}

/** Desktop side: start, watch, approve or deny a pairing; list and revoke linked phones. */
export const deviceRoutes = new Hono<AppEnv>()
  .get("/", async (c) => c.json({ devices: await asMe(c, (tx, auth) => listDevices(tx, auth)) }))
  .post("/pair", async (c) => {
    const { config } = c.get("deps");
    const p = await asMe(c, (tx, auth) => startPairing(tx, auth));
    const auth = requireAuth(c);
    // The code rides in the fragment: browsers never send it to the server or in a Referer.
    return c.json({ id: p.id, url: `${originOf(c, config)}/auth/pair#c=${auth.tenantId}.${p.code}`, expiresAt: p.expiresAt }, 201);
  })
  .get("/pair/:id", async (c) => c.json({ pairing: await asMe(c, (tx, auth) => getPairing(tx, auth, c.req.param("id"))) }))
  .post("/pair/:id/approve", async (c) =>
    c.json({ pairing: await asMe(c, (tx, auth) => decidePairing(tx, auth, c.req.param("id"), true)) }),
  )
  .post("/pair/:id/deny", async (c) =>
    c.json({ pairing: await asMe(c, (tx, auth) => decidePairing(tx, auth, c.req.param("id"), false)) }),
  )
  .delete("/:id", async (c) => {
    await asMe(c, (tx, auth) => revokeDevice(tx, auth, c.req.param("id")));
    return c.json({ ok: true });
  });

const PAIR_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Link this phone · Tend 24/7</title><style>${PAGE_STYLE}</style></head>
<body><main><h1>Link this phone</h1><p id="msg">Checking the code…</p><div id="match" hidden><p>Your computer should show</p><div class="big" id="num"></div><p id="dev"></p></div></main>
<script>
const p=new URLSearchParams(location.hash.slice(1));const code=p.get("c");history.replaceState(null,"",location.pathname);
const $=(id)=>document.getElementById(id);
const post=(path,body)=>fetch(path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body||{})});
const stop=(text)=>{$("msg").textContent=text;$("match").hidden=true;};
(async()=>{if(!code){stop("Scan the QR code on your computer to link this phone.");return;}
const r=await post("/auth/pair/claim",{code});if(!r.ok){stop("This code has expired or was already used. Show a new one on your computer.");return;}
const d=await r.json();$("num").textContent=d.matchNumber;$("dev").textContent=d.deviceLabel;$("match").hidden=false;
$("msg").textContent="Approve this phone on your computer. Check the number matches.";
const started=Date.now();
const poll=async()=>{if(Date.now()-started>5*60*1000){stop("The approval timed out. Start again on your computer.");return;}
const s=await post("/auth/pair/status");const {status}=s.ok?await s.json():{status:"expired"};
if(status==="approved"){const x=await post("/auth/pair/redeem");if(x.ok){$("msg").textContent="Linked. Opening Tend 24/7…";location.replace("/m");}else stop("That did not work. Start again on your computer.");return;}
if(status==="denied"){stop("Your computer declined this phone.");return;}
if(status!=="claimed"){stop("This request expired. Start again on your computer.");return;}
setTimeout(poll,2000);};setTimeout(poll,2000);})();
</script></body></html>`;

function where(c: Ctx): string | null {
  const cf = (c.req.raw as Request & { cf?: { city?: string; country?: string } }).cf;
  if (!cf?.country) return null;
  return cf.city ? `${cf.city}, ${cf.country}` : cf.country;
}

/** Phone side: the page the QR code opens, and its claim / status / redeem calls. */
export const pairRoutes = new Hono<AppEnv>()
  .get("/", (c) => htmlPage(c, PAIR_PAGE))
  .post("/claim", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { code?: unknown };
    if (typeof body.code !== "string") throw new AppError("bad_request", "Missing code");
    const claim = await claimPairing(c.get("sql"), body.code, c.req.header("user-agent") ?? "", where(c));
    setCookie(c, CLAIM_COOKIE, claim.cookie, {
      httpOnly: true,
      secure: isSecure(c),
      sameSite: "Strict",
      path: "/auth/pair",
      maxAge: 600,
    });
    return c.json({ deviceLabel: claim.deviceLabel, matchNumber: claim.matchNumber });
  })
  .post("/status", async (c) => c.json({ status: await claimStatus(c.get("sql"), getCookie(c, CLAIM_COOKIE)) }))
  .post("/redeem", async (c) => {
    const session = await redeemPairing(c.get("sql"), getCookie(c, CLAIM_COOKIE));
    deleteCookie(c, CLAIM_COOKIE, { path: "/auth/pair", secure: isSecure(c) });
    setCookie(c, sessionCookieName(c), session.cookieValue, {
      httpOnly: true,
      secure: isSecure(c),
      sameSite: "Lax",
      path: "/",
      expires: session.expiresAt,
    });
    return c.json({ ok: true, readOnly: true, expiresAt: session.expiresAt });
  });
