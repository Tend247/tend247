// Server-side limits on what a credential may call, checked before any route runs:
//  - a paired phone's read-only session may call only the read routes listed here;
//  - an API token may call only the routes its scopes cover (tokens/service.ts).
// Both are allowlists: a route added later is refused until someone lists it on purpose.
import type { AuthContext } from "./sessions.ts";
import { scopeFor } from "../tokens/service.ts";
import { AppError } from "../lib/errors.ts";

const ID = "[^/]+";
const READ_ONLY_ROUTES: [method: string, path: RegExp][] = [
  ["GET", /^\/api\/me$/],
  ["GET", /^\/api\/config$/],
  ["GET", /^\/api\/users$/],
  ["GET", /^\/api\/teams$/],
  ["GET", /^\/api\/records$/],
  ["GET", new RegExp(`^/api/records/${ID}$`)],
  ["GET", new RegExp(`^/api/records/${ID}/comments$`)],
  ["GET", new RegExp(`^/api/records/${ID}/attachments$`)],
  ["GET", new RegExp(`^/api/attachments/${ID}$`)],
  ["GET", /^\/api\/notifications$/],
  ["GET", /^\/api\/approvals$/],
  ["GET", /^\/api\/dashboard$/],
  ["GET", /^\/api\/demo\/info$/],
  ["POST", /^\/auth\/logout$/],
  // Public routes the phone may still load.
  ["GET", /^\/auth\/config$/],
  ["GET", /^\/auth\/demo\/stats$/],
  ["GET", /^\/healthz$/],
];

export function readOnlyAllows(method: string, path: string): boolean {
  const m = method === "HEAD" ? "GET" : method;
  return READ_ONLY_ROUTES.some(([rm, re]) => rm === m && re.test(path));
}

/** Throw unless this credential may make this request. */
export function enforceAccess(auth: AuthContext | null, method: string, path: string): void {
  if (!auth) return;
  if (auth.kind === "token") {
    const scope = scopeFor(method, path);
    if (!scope) throw new AppError("forbidden", "API tokens cannot use this endpoint", { reason: "token_route" });
    if (scope !== "any" && !auth.scopes?.includes(scope)) {
      throw new AppError("forbidden", `This token does not have the ${scope} scope`, { reason: "token_scope", scope });
    }
    return;
  }
  // Deny by default: a read-only session may call only the listed routes, plus the phone
  // pairing page itself (so a linked phone can be re-linked).
  if (auth.readOnly && !readOnlyAllows(method, path) && !/^\/auth\/pair(\/|$)/.test(path)) {
    throw new AppError("forbidden", "This device has read-only access. Use your computer to make changes.", { reason: "read_only" });
  }
}
