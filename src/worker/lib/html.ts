// Small server-rendered pages (sign-in links, approvals, phone pairing). Each response gets a
// strict Content-Security-Policy with a fresh nonce: only this page's own inline script and
// style run, and the page can only talk to its own origin.
import type { Context } from "hono";
import { randomToken } from "./crypto.ts";

export function htmlPage(c: Context, html: string): Response {
  const nonce = randomToken(16);
  const body = html.replaceAll("<script>", `<script nonce="${nonce}">`).replaceAll("<style>", `<style nonce="${nonce}">`);
  return c.html(body, 200, {
    "content-security-policy": [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      "connect-src 'self'",
      "img-src 'self' data:",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
}

/** Shared look for the server-rendered pages. */
export const PAGE_STYLE = `body{font-family:system-ui,sans-serif;background:#101317;color:#e7e9ec;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.4rem}p{color:#9aa3ae;line-height:1.5}button{font:inherit;font-weight:700;padding:.8rem 1.4rem;border-radius:8px;border:0;background:#f2a33a;color:#1c1206;cursor:pointer}.big{font-size:2.6rem;font-weight:800;letter-spacing:.1em;color:#f2a33a;margin:.4rem 0}`;
