// Forward-only SQL migration runner (Node). Used by `npm run db:migrate`, the test setup
// and, later, the install script. Runs as the schema OWNER, never as the app role.
import { readdir, readFile } from "node:fs/promises";
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { join } from "node:path";
import postgres from "postgres";

export interface MigrateOptions {
  ownerUrl: string;
  migrationsDir: string;
  appRole?: string;
  appPassword?: string;
  log?: (line: string) => void;
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

const LOCK_KEY = 7247_0001;

export async function migrate(opts: MigrateOptions): Promise<MigrateResult> {
  const log = opts.log ?? (() => {});
  const sql = postgres(opts.ownerUrl, { max: 1, onnotice: () => {} });
  const result: MigrateResult = { applied: [], skipped: [] };
  try {
    await sql`select pg_advisory_lock(${LOCK_KEY})`;
    await sql`
      create table if not exists schema_migrations (
        name text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )`;
    const done = new Map<string, string>();
    for (const row of await sql<{ name: string; checksum: string }[]>`select name, checksum from schema_migrations`) {
      done.set(row.name, row.checksum);
    }
    const files = (await readdir(opts.migrationsDir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    for (const file of files) {
      const body = await readFile(join(opts.migrationsDir, file), "utf8");
      const checksum = createHash("sha256").update(body).digest("hex");
      const previous = done.get(file);
      if (previous) {
        if (previous !== checksum) {
          throw new Error(`Migration ${file} was edited after it was applied. Add a new migration instead.`);
        }
        result.skipped.push(file);
        continue;
      }
      log(`applying ${file}`);
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`insert into schema_migrations (name, checksum) values (${file}, ${checksum})`;
      });
      result.applied.push(file);
    }
    if (opts.appRole) await grantAppRole(sql, opts.appRole, opts.appPassword, log);
  } finally {
    await sql`select pg_advisory_unlock(${LOCK_KEY})`.catch(() => {});
    await sql.end();
  }
  return result;
}

async function grantAppRole(sql: postgres.Sql, role: string, password: string | undefined, log: (l: string) => void) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) throw new Error(`Invalid app role name: ${role}`);
  const [existing] = await sql<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
    select rolsuper, rolbypassrls from pg_roles where rolname = ${role}`;
  if (!existing) {
    if (!password) {
      log(`app role ${role} does not exist; set TEND247_DB_APP_PASSWORD to create it`);
      return;
    }
    // Send a SCRAM verifier, never the plaintext: CREATE ROLE statements can end up in server logs.
    await sql.unsafe(`create role ${role} login nobypassrls password ${quoteLiteral(scramVerifier(password))}`);
    log(`created app role ${role}`);
  } else if (existing.rolsuper || existing.rolbypassrls) {
    throw new Error(`App role ${role} is a superuser or has BYPASSRLS; tenant isolation would not hold.`);
  }
  await sql.unsafe(`
    grant usage on schema public to ${role};
    grant select, insert, update, delete on all tables in schema public to ${role};
    grant usage, select on all sequences in schema public to ${role};
    revoke all on table schema_migrations from ${role};
    grant select on table schema_migrations to ${role};
  `);
}

/** Postgres SCRAM-SHA-256 password verifier (RFC 5802 / 7677), as stored in pg_authid. */
export function scramVerifier(password: string, iterations = 4096): string {
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password.normalize("NFKC"), salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
  return `SCRAM-SHA-256$${iterations}:${b64(salt)}$${b64(storedKey)}:${b64(serverKey)}`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
