import type { Sql, Tx } from "../db/client.ts";
import { withTenant } from "../db/client.ts";
import { isUuid, randomToken, sha256Hex } from "../lib/crypto.ts";

export type Role = "admin" | "agent" | "requester";

export interface AuthContext {
  tenantId: string;
  userId: string;
  role: Role;
  email: string;
  displayName: string;
  /** Hash of the session token (empty for API tokens). */
  sessionHash: string;
  /** How the request authenticated: a browser session cookie or an API token. */
  kind: "session" | "token";
  /** API tokens only: the token and what it may do. */
  tokenId?: string;
  scopes?: string[];
  /** A paired phone: may only read, through an explicit list of routes (see access.ts). */
  readOnly: boolean;
  /** The workspace is a public demo sandbox (guardrails apply). */
  demo: boolean;
}

/** Create a session. The cookie carries `<workspace id>.<random token>`; only a hash is stored. */
export async function createSession(
  tx: Tx,
  input: { tenantId: string; userId: string; ttlHours: number; readOnly?: boolean; pairingId?: string; notAfter?: Date | null },
): Promise<{ cookieValue: string; expiresAt: Date; hash: string }> {
  const token = randomToken(32);
  const hash = await sha256Hex(token);
  let expiresAt = new Date(Date.now() + input.ttlHours * 3600_000);
  // A session never outlives its workspace (demo sandboxes expire).
  if (input.notAfter && input.notAfter < expiresAt) expiresAt = input.notAfter;
  await tx`
    insert into sessions (token_hash, tenant_id, user_id, expires_at, read_only, pairing_id)
    values (${hash}, ${input.tenantId}, ${input.userId}, ${expiresAt}, ${input.readOnly ?? false}, ${input.pairingId ?? null})`;
  return { cookieValue: `${input.tenantId}.${token}`, expiresAt, hash };
}

export function parseSessionCookie(value: string | undefined): { tenantId: string; token: string } | null {
  if (!value) return null;
  const dot = value.indexOf(".");
  if (dot < 0) return null;
  const tenantId = value.slice(0, dot);
  const token = value.slice(dot + 1);
  if (!isUuid(tenantId) || !/^[A-Za-z0-9_-]{20,128}$/.test(token)) return null;
  return { tenantId, token };
}

export async function resolveSession(sql: Sql, cookieValue: string | undefined): Promise<AuthContext | null> {
  const parsed = parseSessionCookie(cookieValue);
  if (!parsed) return null;
  const hash = await sha256Hex(parsed.token);
  return withTenant(sql, parsed.tenantId, async (tx) => {
    const [row] = await tx<
      { userId: string; role: Role; email: string; displayName: string; lastSeenAt: Date; readOnly: boolean; demo: boolean }[]
    >`
      select s.user_id, u.role, u.email, u.display_name, s.last_seen_at, s.read_only, t.demo
      from sessions s
      join users u on u.id = s.user_id
      join tenants t on t.id = s.tenant_id
      where s.token_hash = ${hash} and s.expires_at > now() and u.active
        and (t.expires_at is null or t.expires_at > now())
        and (t.demo_state is null or t.demo_state = 'claimed')`;
    if (!row) return null;
    if (Date.now() - row.lastSeenAt.getTime() > 5 * 60_000) {
      await tx`update sessions set last_seen_at = now() where token_hash = ${hash}`;
      // The demo simulator only runs for sandboxes someone is looking at.
      if (row.demo) await tx`update tenants set last_active_at = now() where id = ${parsed.tenantId}`;
    }
    return {
      tenantId: parsed.tenantId,
      userId: row.userId,
      role: row.role,
      email: row.email,
      displayName: row.displayName,
      sessionHash: hash,
      kind: "session",
      readOnly: row.readOnly,
      demo: row.demo,
    };
  });
}

export async function destroySession(sql: Sql, auth: AuthContext): Promise<void> {
  await withTenant(sql, auth.tenantId, async (tx) => {
    await tx`delete from sessions where token_hash = ${auth.sessionHash}`;
  });
}
