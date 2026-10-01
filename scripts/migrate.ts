// npm run db:migrate — apply pending migrations as the schema owner and grant the app role.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { migrate } from "./lib/migrator.ts";
import { loadDotEnv } from "./lib/dotenv.ts";

loadDotEnv();
const ownerUrl = process.env.TEND247_DB_OWNER_URL;
if (!ownerUrl) {
  console.error("TEND247_DB_OWNER_URL is not set (see .env.example).");
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const result = await migrate({
  ownerUrl,
  migrationsDir: join(root, "migrations"),
  appRole: process.env.TEND247_DB_APP_ROLE || "tend247_app",
  appPassword: process.env.TEND247_DB_APP_PASSWORD || undefined,
  log: (line) => console.log(line),
});
console.log(`migrations: ${result.applied.length} applied, ${result.skipped.length} already up to date`);
