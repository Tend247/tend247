// Reset the test database to an empty schema and apply every migration once per run.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postgres from "postgres";
import { migrate } from "../../scripts/lib/migrator.ts";
import { APP_ROLE, OWNER_URL } from "./env.ts";

export default async function setup(): Promise<void> {
  const sql = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe("drop schema if exists public cascade; create schema public;");
  } finally {
    await sql.end();
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  await migrate({
    ownerUrl: OWNER_URL,
    migrationsDir: join(root, "migrations"),
    appRole: APP_ROLE,
    // CI against a hosted Postgres (PlanetScale) creates the app role on first run.
    appPassword: process.env.TEND247_DB_APP_PASSWORD || undefined,
  });
}
