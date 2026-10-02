// Scripts that read or write one workspace refuse a connection that can bypass row-level
// security: isolation must not depend on every query remembering its tenant filter.
import type { Sql } from "../../src/worker/db/client.ts";

export async function assertRlsApplies(sql: Sql): Promise<void> {
  const [r] = await sql<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }[]>`
    select rolname, rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
  if (r?.rolsuper || r?.rolbypassrls) {
    throw new Error(
      `The role "${r.rolname}" is a superuser or has BYPASSRLS. Connect as the schema owner role created for Tend 24/7 ` +
        "(see docs/install.md), not the provider's default admin role.",
    );
  }
}
