import type { Sql } from "./client.ts";

export interface DatabaseCheck {
  ok: boolean;
  problems: string[];
}

/**
 * Refuse to serve unless the connection is safe for multi-workspace data:
 *  - the role cannot bypass row-level security (not a superuser, no BYPASSRLS),
 *  - the role does not own the schema (an owner could switch row-level security off),
 *  - the schema is migrated and pg_trgm is installed,
 *  - Hyperdrive query caching is off (a cached read could cross workspaces or go stale).
 * Run once per isolate; the caller caches the result.
 */
export async function checkDatabase(sql: Sql): Promise<DatabaseCheck> {
  const problems: string[] = [];
  const [role] = await sql<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }[]>`
    select rolname, rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
  if (!role) problems.push("could not read the current database role");
  else if (role.rolsuper || role.rolbypassrls) {
    problems.push(`database role "${role.rolname}" is a superuser or has BYPASSRLS; connect as a dedicated app role (see docs/install.md)`);
  }

  const [migrated] = await sql<{ n: number }[]>`
    select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name = 'schema_migrations'`;
  if (!migrated || migrated.n === 0) {
    problems.push("database has not been migrated; run `npm run db:migrate`");
    return { ok: false, problems };
  }

  const [owns] = await sql<{ n: number }[]>`
    select count(*)::int as n from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public' and c.relkind = 'r' and c.relname = 'records'
      and pg_has_role(current_user, c.relowner, 'USAGE')`;
  if (owns && owns.n > 0) {
    problems.push("the app connects as the schema owner; connect as the separate app role so it cannot alter row-level security");
  }

  const [ext] = await sql<{ n: number }[]>`select count(*)::int as n from pg_extension where extname = 'pg_trgm'`;
  if (!ext || ext.n === 0) problems.push("required extension pg_trgm is not installed; run migrations as the schema owner");

  if (problems.length === 0 && (await queryCachingIsOn(sql))) {
    problems.push("Hyperdrive query caching is on; recreate the Hyperdrive config with --caching-disabled (see docs/install.md)");
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Write a value, read it, change it, read it again. With a query cache in front of Postgres
 * the second, identical read returns the first value.
 */
async function queryCachingIsOn(sql: Sql): Promise<boolean> {
  const id = crypto.randomUUID();
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  try {
    await sql`insert into hyperdrive_probe (id, value) values (${id}, ${first})`;
    await sql`select value from hyperdrive_probe where id = ${id}`;
    await sql`update hyperdrive_probe set value = ${second} where id = ${id}`;
    const [row] = await sql<{ value: string }[]>`select value from hyperdrive_probe where id = ${id}`;
    return row?.value !== second;
  } finally {
    await sql`delete from hyperdrive_probe where id = ${id} or created_at < now() - interval '1 hour'`.catch(() => {});
  }
}
