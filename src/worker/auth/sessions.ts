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
  sessionHash: string;
}

/** Create a session. The cookie carries `<workspace id>.<random token>`; only a hash is stored. */
export async function createSession(
  tx: Tx,
  input: { tenantId: string; userId: string; ttlHours: number },
): Promise<{ cookieValue: string; expiresAt: Date }> {
  const token = randomToken(32);
  const hash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + input.ttlHours * 3600_000);
  await tx`
    insert into sessions (token_hash, tenant_id, user_id, expires_at)
    values (${hash}, ${input.tenantId}, ${input.userId}, ${expiresAt})`;
  return { cookieValue: `${input.tenantId}.${token}`, expiresAt };
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
      { userId: string; role: Role; email: string; displayName: string; lastSeenAt: Date }[]
    >`
      select s.user_id, u.role, u.email, u.display_name, s.last_seen_at
      from sessions s
      join users u on u.id = s.user_id
      join tenants t on t.id = s.tenant_id
      where s.token_hash = ${hash} and s.expires_at > now() and u.active
        and (t.expires_at is null or t.expires_at > now())`;
    if (!row) return null;
    if (Date.now() - row.lastSeenAt.getTime() > 5 * 60_000) {
      await tx`update sessions set last_seen_at = now() where token_hash = ${hash}`;
    }
    return {
      tenantId: parsed.tenantId,
      userId: row.userId,
      role: row.role,
      email: row.email,
      displayName: row.displayName,
      sessionHash: hash,
    };
  });
}

export async function destroySession(sql: Sql, auth: AuthContext): Promise<void> {
  await withTenant(sql, auth.tenantId, async (tx) => {
    await tx`delete from sessions where token_hash = ${auth.sessionHash}`;
  });
}
