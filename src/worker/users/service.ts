import { z } from "zod";
import type { Tx } from "../db/client.ts";
import { audit, type Actor } from "../audit.ts";
import { AppError, invalid, notFound } from "../lib/errors.ts";
import type { Role } from "../auth/sessions.ts";

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  active: boolean;
  createdAt: Date;
}

const newUserSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  displayName: z.string().trim().min(1).max(200),
  role: z.enum(["admin", "agent", "requester"]),
});

const userPatchSchema = z
  .object({
    displayName: z.string().trim().min(1).max(200),
    role: z.enum(["admin", "agent", "requester"]),
    active: z.boolean(),
  })
  .partial()
  .strict();

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw invalid(r.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })));
  return r.data;
}

export async function listUsers(tx: Tx, opts: { includeInactive?: boolean } = {}): Promise<User[]> {
  return tx<User[]>`
    select id, email, display_name, role, active, created_at from users
    where ${opts.includeInactive ? tx`true` : tx`active`}
    order by display_name, email`;
}

export async function findUserByEmail(tx: Tx, email: string): Promise<(User & { oidcSubject: string | null }) | null> {
  const [u] = await tx<(User & { oidcSubject: string | null })[]>`
    select id, email, display_name, role, active, created_at, oidc_subject from users where email = ${email.toLowerCase()}`;
  return u ?? null;
}

/** Insert a user without an acting admin (sign-in provisioning, seeds). */
export async function insertUser(
  tx: Tx,
  tenantId: string,
  input: { email: string; displayName: string; role: Role; oidcSubject?: string | null },
): Promise<User> {
  const [quota] = await tx<{ maxUsers: number | null }[]>`select max_users from tenants where id = ${tenantId}`;
  if (quota?.maxUsers) {
    const [n] = await tx<{ n: number }[]>`select count(*)::int as n from users`;
    if ((n?.n ?? 0) >= quota.maxUsers) throw new AppError("forbidden", `This workspace holds up to ${quota.maxUsers} people`);
  }
  const [u] = await tx<User[]>`
    insert into users (tenant_id, email, display_name, role, oidc_subject)
    values (${tenantId}, ${input.email.toLowerCase()}, ${input.displayName}, ${input.role}, ${input.oidcSubject ?? null})
    returning id, email, display_name, role, active, created_at`;
  return u!;
}

export async function createUser(tx: Tx, actor: Actor, input: unknown): Promise<User> {
  const data = parse(newUserSchema, input);
  const user = await insertUser(tx, actor.tenantId, data);
  await audit(tx, actor, { entity: "user", entityId: user.id, action: "create", after: user });
  return user;
}

export async function updateUser(tx: Tx, actor: Actor, rawId: string, input: unknown): Promise<User> {
  const patch = parse(userPatchSchema, input);
  const [before] = await tx<User[]>`
    select id, email, display_name, role, active, created_at from users where id = ${rawId} for update`;
  if (!before) throw notFound("User");
  const id = before.id; // canonical form from the database, whatever case the caller used
  const losesAdmin = before.role === "admin" && ((patch.role !== undefined && patch.role !== "admin") || patch.active === false);
  if (id === actor.userId && losesAdmin) {
    throw new AppError("bad_request", "You cannot remove your own admin access");
  }
  if (losesAdmin) {
    const [{ n } = { n: 0 }] = await tx<{ n: number }[]>`
      select count(*)::int as n from users where role = 'admin' and active and id <> ${id}`;
    if (n === 0) throw new AppError("bad_request", "A workspace needs at least one active admin");
  }
  const [after] = await tx<User[]>`
    update users set
      display_name = ${patch.displayName ?? before.displayName},
      role = ${patch.role ?? before.role},
      active = ${patch.active ?? before.active}
    where id = ${id}
    returning id, email, display_name, role, active, created_at`;
  if (patch.active === false || (patch.role && patch.role !== before.role)) {
    await tx`delete from sessions where user_id = ${id}`;
  }
  await audit(tx, actor, { entity: "user", entityId: id, action: "update", before, after });
  return after!;
}

/** Confirm every referenced user exists and is active in the current workspace. */
export async function assertUsersExist(tx: Tx, refs: { field: string; id: string }[]): Promise<void> {
  if (refs.length === 0) return;
  const ids = [...new Set(refs.map((r) => r.id))];
  // Lists travel as JSON: the client runs without fetched type info (one less round trip per
  // request), so native array parameters are not available.
  const found = await tx<{ id: string }[]>`
    select id from users
    where active and id in (select jsonb_array_elements_text(${tx.json(ids)})::uuid)`;
  const ok = new Set(found.map((f) => f.id));
  const missing = refs.filter((r) => !ok.has(r.id));
  if (missing.length) throw invalid(missing.map((m) => ({ field: m.field, message: "No such active person" })));
}
