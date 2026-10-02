// Read-only phone access by QR code.
//
//  1. A signed-in desktop asks for a pairing. The QR code carries a one-time 128-bit code in
//     the URL fragment (never sent to the server in a request line, so it stays out of logs).
//  2. The phone opens /auth/pair, which reads the fragment, wipes it from history and claims
//     the code with a POST. Claiming uses the code up and gives the phone a second secret
//     (an HttpOnly cookie) that only that phone holds.
//  3. The desktop shows the phone's device, browser and a two-digit match number, and the
//     person approves or denies it.
//  4. The phone redeems its claim for a 4-hour session flagged read_only, for the same person.
//     The server allows such a session only an explicit list of read routes (auth/access.ts).
// Every step is time-limited and audited; linked devices can be revoked at any time.
import type { Sql, Tx } from "../db/client.ts";
import { withTenant } from "../db/client.ts";
import { audit, type Actor } from "../audit.ts";
import { createSession, type AuthContext } from "../auth/sessions.ts";
import { AppError, forbidden, notFound } from "../lib/errors.ts";
import { isUuid, randomToken, sha256Hex } from "../lib/crypto.ts";

export const CODE_MINUTES = 2;
export const APPROVE_MINUTES = 5;
export const READ_ONLY_HOURS = 4;

export type PairingStatus = "pending" | "claimed" | "approved" | "denied" | "redeemed" | "expired" | "revoked";

export interface Pairing {
  id: string;
  status: PairingStatus;
  deviceLabel: string | null;
  matchNumber: number | null;
  expiresAt: Date;
}

const actorOf = (auth: AuthContext): Actor => ({ tenantId: auth.tenantId, userId: auth.userId, role: auth.role });

/** Two digits both screens show, so a person can tell their own phone claimed the code. */
export function matchNumber(claimHash: string | null): number | null {
  return claimHash ? (parseInt(claimHash.slice(0, 6), 16) % 90) + 10 : null;
}

/** "iPhone · Safari" from a user-agent string; good enough to recognise your own phone. */
export function deviceLabel(ua: string): string {
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Mac OS X|Macintosh/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux/.test(ua)
              ? "Linux"
              : "Unknown device";
  const browser = /SamsungBrowser/.test(ua)
    ? "Samsung Internet"
    : /EdgA?\//.test(ua)
      ? "Edge"
      : /FxiOS|Firefox\//.test(ua)
        ? "Firefox"
        : /CriOS|Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "browser";
  return `${os} · ${browser}`;
}

function assertDesktop(auth: AuthContext): void {
  if (auth.kind !== "session" || auth.readOnly) throw forbidden("Start pairing from a signed-in computer");
}

async function expireStale(tx: Tx): Promise<void> {
  await tx`
    update device_pairings set status = 'expired'
    where status in ('pending', 'claimed', 'approved') and expires_at <= now()`;
}

export async function startPairing(tx: Tx, auth: AuthContext): Promise<{ id: string; code: string; expiresAt: Date }> {
  assertDesktop(auth);
  const [recent] = await tx<{ n: number }[]>`
    select count(*)::int as n from device_pairings where user_id = ${auth.userId} and created_at > now() - interval '10 minutes'`;
  if ((recent?.n ?? 0) >= 10) throw new AppError("rate_limited", "Too many pairing attempts; wait a few minutes");
  const code = randomToken(16);
  const expiresAt = new Date(Date.now() + CODE_MINUTES * 60_000);
  const [row] = await tx<{ id: string }[]>`
    insert into device_pairings (tenant_id, user_id, code_hash, expires_at)
    values (${auth.tenantId}, ${auth.userId}, ${await sha256Hex(code)}, ${expiresAt})
    returning id`;
  await audit(tx, actorOf(auth), { entity: "device", entityId: row!.id, action: "pair_requested" });
  return { id: row!.id, code, expiresAt };
}

export async function getPairing(tx: Tx, auth: AuthContext, id: string): Promise<Pairing> {
  assertDesktop(auth);
  if (!isUuid(id)) throw notFound("Pairing");
  await expireStale(tx);
  const [p] = await tx<(Pairing & { claimHash: string | null })[]>`
    select id, status, device_label, claim_hash, expires_at from device_pairings where id = ${id} and user_id = ${auth.userId}`;
  if (!p) throw notFound("Pairing");
  const { claimHash, ...rest } = p;
  return { ...rest, matchNumber: matchNumber(claimHash) };
}

export async function decidePairing(tx: Tx, auth: AuthContext, id: string, approve: boolean): Promise<Pairing> {
  assertDesktop(auth);
  if (!isUuid(id)) throw notFound("Pairing");
  await expireStale(tx);
  const [p] = await tx<{ id: string; deviceLabel: string | null }[]>`
    update device_pairings set status = ${approve ? "approved" : "denied"}, decided_at = now(),
      expires_at = least(expires_at, now() + make_interval(mins => ${APPROVE_MINUTES}))
    where id = ${id} and user_id = ${auth.userId} and status = 'claimed' and expires_at > now()
    returning id, device_label`;
  if (!p) throw new AppError("conflict", "This pairing is no longer waiting for approval; start again");
  await audit(tx, actorOf(auth), { entity: "device", entityId: id, action: approve ? "pair_approved" : "pair_denied", after: { device: p.deviceLabel } });
  return getPairing(tx, auth, id);
}

/** Parse "<workspace id>.<code>" from the QR fragment. */
export function parsePairCode(value: string): { tenantId: string; code: string } | null {
  const m = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{20,32})$/i.exec(value);
  return m && isUuid(m[1]) ? { tenantId: m[1]!.toLowerCase(), code: m[2]! } : null;
}

/** The phone claims the code. Returns the phone's own secret (kept in an HttpOnly cookie). */
export async function claimPairing(
  sql: Sql,
  value: string,
  ua: string,
  where: string | null,
): Promise<{ cookie: string; deviceLabel: string; matchNumber: number }> {
  const parsed = parsePairCode(value);
  const invalid = () => new AppError("bad_request", "This code has expired or was already used. Show a new one on your computer.");
  if (!parsed) throw invalid();
  const secret = randomToken(32);
  const claimHash = await sha256Hex(secret);
  const label = (deviceLabel(ua) + (where ? ` · ${where}` : "")).slice(0, 120);
  const row = await withTenant(sql, parsed.tenantId, async (tx) => {
    const [p] = await tx<{ id: string; userId: string }[]>`
      update device_pairings set status = 'claimed', claimed_at = now(), claim_hash = ${claimHash},
        device_label = ${label}, user_agent = ${ua.slice(0, 500)},
        expires_at = now() + make_interval(mins => ${APPROVE_MINUTES})
      where code_hash = ${await sha256Hex(parsed.code)} and status = 'pending' and expires_at > now()
      returning id, user_id`;
    if (p) {
      await audit(tx, { tenantId: parsed.tenantId, userId: p.userId, role: "requester" }, {
        entity: "device",
        entityId: p.id,
        action: "pair_claimed",
        after: { device: label },
      });
    }
    return p ?? null;
  });
  if (!row) throw invalid();
  return { cookie: `${parsed.tenantId}.${row.id}.${secret}`, deviceLabel: label, matchNumber: matchNumber(claimHash)! };
}

function parseClaimCookie(value: string | undefined): { tenantId: string; id: string; secret: string } | null {
  const m = /^([0-9a-f-]{36})\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/i.exec(value ?? "");
  return m && isUuid(m[1]) && isUuid(m[2]) ? { tenantId: m[1]!.toLowerCase(), id: m[2]!.toLowerCase(), secret: m[3]! } : null;
}

/** The phone polls this while the desktop decides. */
export async function claimStatus(sql: Sql, cookie: string | undefined): Promise<PairingStatus> {
  const parsed = parseClaimCookie(cookie);
  if (!parsed) return "expired";
  const hash = await sha256Hex(parsed.secret);
  return withTenant(sql, parsed.tenantId, async (tx) => {
    await expireStale(tx);
    const [p] = await tx<{ status: PairingStatus }[]>`
      select status from device_pairings where id = ${parsed.id} and claim_hash = ${hash}`;
    return p?.status ?? "expired";
  });
}

/** The approved phone trades its claim for a read-only session. */
export async function redeemPairing(sql: Sql, cookie: string | undefined): Promise<{ cookieValue: string; expiresAt: Date }> {
  const parsed = parseClaimCookie(cookie);
  const refused = () => new AppError("forbidden", "This phone has not been approved, or the approval expired");
  if (!parsed) throw refused();
  const hash = await sha256Hex(parsed.secret);
  return withTenant(sql, parsed.tenantId, async (tx) => {
    const [p] = await tx<{ id: string; userId: string; deviceLabel: string | null; workspaceExpires: Date | null }[]>`
      select p.id, p.user_id, p.device_label, t.expires_at as workspace_expires
      from device_pairings p join users u on u.id = p.user_id join tenants t on t.id = p.tenant_id
      where p.id = ${parsed.id} and p.claim_hash = ${hash} and p.status = 'approved' and p.expires_at > now() and u.active
      for update of p`;
    if (!p) throw refused();
    const session = await createSession(tx, {
      tenantId: parsed.tenantId,
      userId: p.userId,
      ttlHours: READ_ONLY_HOURS,
      readOnly: true,
      pairingId: p.id,
      notAfter: p.workspaceExpires,
    });
    await tx`
      update device_pairings set status = 'redeemed', redeemed_at = now(), session_expires_at = ${session.expiresAt}
      where id = ${p.id}`;
    await audit(tx, { tenantId: parsed.tenantId, userId: p.userId, role: "requester" }, {
      entity: "device",
      entityId: p.id,
      action: "paired",
      after: { device: p.deviceLabel, readOnly: true, expiresAt: session.expiresAt },
    });
    return { cookieValue: session.cookieValue, expiresAt: session.expiresAt };
  });
}

export interface LinkedDevice {
  id: string;
  deviceLabel: string | null;
  pairedAt: Date;
  expiresAt: Date;
  lastSeenAt: Date | null;
}

export async function listDevices(tx: Tx, auth: AuthContext): Promise<LinkedDevice[]> {
  return tx<LinkedDevice[]>`
    select p.id, p.device_label, p.redeemed_at as paired_at, s.expires_at, s.last_seen_at
    from device_pairings p join sessions s on s.pairing_id = p.id
    where p.user_id = ${auth.userId} and p.status = 'redeemed' and s.expires_at > now()
    order by p.redeemed_at desc`;
}

export async function revokeDevice(tx: Tx, auth: AuthContext, id: string): Promise<void> {
  if (!isUuid(id)) throw notFound("Device");
  if (auth.readOnly) throw forbidden();
  const [p] = await tx<{ id: string; deviceLabel: string | null }[]>`
    update device_pairings set status = 'revoked' where id = ${id} and user_id = ${auth.userId} and status = 'redeemed'
    returning id, device_label`;
  if (!p) throw notFound("Device");
  await tx`delete from sessions where pairing_id = ${id}`;
  await audit(tx, actorOf(auth), { entity: "device", entityId: id, action: "revoked", before: { device: p.deviceLabel } });
}
