// API tokens: `Authorization: Bearer t247.<workspace id>.<secret>`. A token acts as the person
// who made it, with that person's current role and visibility, limited to its scopes. Only a
// hash of the secret is stored; the secret is shown once, when the token is created.
import { z } from "zod";
import type { Sql, Tx } from "../db/client.ts";
import { withTenant } from "../db/client.ts";
import { audit, isStaff, type Actor } from "../audit.ts";
import type { AuthContext, Role } from "../auth/sessions.ts";
import { AppError, forbidden, notFound } from "../lib/errors.ts";
import { isUuid, randomToken, sha256Hex } from "../lib/crypto.ts";
import { parse } from "../lib/validate.ts";

export const SCOPES = ["records:read", "records:write", "comments:read", "comments:write", "config:read"] as const;
export type Scope = (typeof SCOPES)[number];
export const READ_SCOPES: Scope[] = ["records:read", "comments:read", "config:read"];

export interface ApiToken {
  id: string;
  userId: string;
  userName?: string;
  name: string;
  hint: string;
  scopes: Scope[];
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  scopes: z.array(z.enum(SCOPES)).min(1).max(SCOPES.length),
  /** Days until it stops working; null for no expiry. */
  expiresInDays: z.number().int().min(1).max(730).nullable().default(90),
});

const COLUMNS = (tx: Tx) => tx`
  t.id, t.user_id, u.display_name as user_name, t.name, t.hint, t.scopes, t.expires_at, t.last_used_at, t.revoked_at, t.created_at`;

export async function listTokens(tx: Tx, actor: Actor, opts: { all?: boolean } = {}): Promise<ApiToken[]> {
  const everyone = opts.all && actor.role === "admin";
  return tx<ApiToken[]>`
    select ${COLUMNS(tx)} from api_tokens t join users u on u.id = t.user_id
    where ${everyone ? tx`true` : tx`t.user_id = ${actor.userId}`}
    order by t.revoked_at nulls first, t.created_at desc limit 200`;
}

export async function createToken(
  tx: Tx,
  actor: Actor,
  input: unknown,
  opts: { demo?: boolean; readOnly?: boolean } = {},
): Promise<{ token: ApiToken; secret: string }> {
  if (!actor.userId || !isStaff(actor)) throw forbidden("Only admins and agents can create API tokens");
  // Defence in depth: the read-only route allowlist already refuses this.
  if (opts.readOnly) throw forbidden("Create tokens from a signed-in computer");
  const data = parse(createSchema, input);
  const scopes = [...new Set(data.scopes)];
  if (opts.demo && scopes.some((s) => !READ_SCOPES.includes(s))) {
    throw new AppError("forbidden", "Demo workspaces can create read-only tokens only");
  }
  const [active] = await tx<{ n: number }[]>`
    select count(*)::int as n from api_tokens where user_id = ${actor.userId} and revoked_at is null`;
  if ((active?.n ?? 0) >= 25) throw new AppError("conflict", "You already have 25 active tokens; revoke one first");
  const secret = randomToken(32);
  const hash = await sha256Hex(secret);
  const [row] = await tx<{ id: string }[]>`
    insert into api_tokens (tenant_id, user_id, name, token_hash, hint, scopes, expires_at)
    values (${actor.tenantId}, ${actor.userId}, ${data.name}, ${hash}, ${secret.slice(0, 6)}, ${tx.json(scopes)},
            ${data.expiresInDays ? new Date(Date.now() + data.expiresInDays * 86_400_000) : null})
    returning id`;
  const [token] = await tx<ApiToken[]>`select ${COLUMNS(tx)} from api_tokens t join users u on u.id = t.user_id where t.id = ${row!.id}`;
  await audit(tx, actor, { entity: "api_token", entityId: row!.id, action: "create", after: { name: data.name, scopes, expiresAt: token!.expiresAt } });
  return { token: token!, secret: `t247.${actor.tenantId}.${secret}` };
}

export async function revokeToken(tx: Tx, actor: Actor, id: string): Promise<void> {
  if (!isUuid(id)) throw notFound("Token");
  const [t] = await tx<{ userId: string; revokedAt: Date | null; name: string }[]>`
    select user_id, revoked_at, name from api_tokens where id = ${id}`;
  if (!t || (t.userId !== actor.userId && actor.role !== "admin")) throw notFound("Token");
  if (t.revokedAt) return;
  await tx`update api_tokens set revoked_at = now() where id = ${id}`;
  await audit(tx, actor, { entity: "api_token", entityId: id, action: "revoke", before: { name: t.name } });
}

/** Parse the Authorization header; null for anything that is not a well-formed token. */
export function parseBearer(header: string): { tenantId: string; secret: string } | null {
  const m = /^Bearer\s+t247\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{40,64})\s*$/i.exec(header);
  if (!m || !isUuid(m[1])) return null;
  return { tenantId: m[1]!.toLowerCase(), secret: m[2]! };
}

export async function resolveToken(sql: Sql, header: string): Promise<AuthContext | null> {
  const parsed = parseBearer(header);
  if (!parsed) return null;
  const hash = await sha256Hex(parsed.secret);
  return withTenant(sql, parsed.tenantId, async (tx) => {
    const [row] = await tx<
      { id: string; userId: string; role: Role; email: string; displayName: string; scopes: Scope[]; lastUsedAt: Date | null; demo: boolean }[]
    >`
      select t.id, t.user_id, u.role, u.email, u.display_name, t.scopes, t.last_used_at, ten.demo
      from api_tokens t
      join users u on u.id = t.user_id
      join tenants ten on ten.id = t.tenant_id
      where t.token_hash = ${hash} and t.revoked_at is null and (t.expires_at is null or t.expires_at > now())
        and u.active and (ten.expires_at is null or ten.expires_at > now())`;
    if (!row) return null;
    if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) {
      await tx`update api_tokens set last_used_at = now() where id = ${row.id}`;
    }
    return {
      tenantId: parsed.tenantId,
      userId: row.userId,
      role: row.role,
      email: row.email,
      displayName: row.displayName,
      sessionHash: "",
      kind: "token",
      tokenId: row.id,
      scopes: row.scopes,
      readOnly: false,
      demo: row.demo,
    };
  });
}

// ---------------------------------------------------------------- what a token may call

type Rule = [method: string, path: RegExp, scope: Scope | "any"];
const ID = "[^/]+";
const TOKEN_ROUTES: Rule[] = [
  ["GET", /^\/api\/me$/, "any"],
  ["GET", /^\/api\/config$/, "config:read"],
  ["GET", /^\/api\/users$/, "config:read"],
  ["GET", /^\/api\/teams$/, "config:read"],
  ["GET", /^\/api\/records$/, "records:read"],
  ["GET", /^\/api\/board$/, "records:read"],
  ["GET", /^\/api\/dashboard$/, "records:read"],
  ["GET", new RegExp(`^/api/records/${ID}$`), "records:read"],
  ["GET", new RegExp(`^/api/records/${ID}/events$`), "records:read"],
  ["GET", new RegExp(`^/api/records/${ID}/watchers$`), "records:read"],
  ["POST", /^\/api\/records$/, "records:write"],
  ["POST", /^\/api\/records\/bulk$/, "records:write"],
  ["PATCH", new RegExp(`^/api/records/${ID}$`), "records:write"],
  ["DELETE", new RegExp(`^/api/records/${ID}$`), "records:write"],
  ["POST", new RegExp(`^/api/records/${ID}/transitions$`), "records:write"],
  ["POST", new RegExp(`^/api/records/${ID}/links$`), "records:write"],
  ["DELETE", new RegExp(`^/api/links/${ID}$`), "records:write"],
  ["GET", new RegExp(`^/api/records/${ID}/comments$`), "comments:read"],
  ["POST", new RegExp(`^/api/records/${ID}/comments$`), "comments:write"],
  ["GET", new RegExp(`^/api/records/${ID}/attachments$`), "comments:read"],
  ["GET", new RegExp(`^/api/attachments/${ID}$`), "comments:read"],
  ["POST", new RegExp(`^/api/records/${ID}/attachments$`), "comments:write"],
];

/** The scope a request needs, "any", or null when tokens may not call it at all. */
export function scopeFor(method: string, path: string): Scope | "any" | null {
  const m = method === "HEAD" ? "GET" : method;
  for (const [rm, re, scope] of TOKEN_ROUTES) if (rm === m && re.test(path)) return scope;
  return null;
}
