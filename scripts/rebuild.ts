// npm run rebuild — after restoring the database (point-in-time recovery or an import), re-arm
// SLA timers from their stored due times, re-queue events that were never delivered, and make
// sure every workspace has its nightly jobs. Safe to run more than once.
import { createSql } from "../src/worker/db/client.ts";
import { rebuildAfterRestore, type WorkerDeps } from "../src/worker/jobs/runner.ts";
import { loadConfig } from "../src/worker/config.ts";
import { DisabledEmailSender } from "../src/worker/email/sender.ts";
import { loadDotEnv } from "./lib/dotenv.ts";

loadDotEnv();
const url = process.env.TEND247_DB_OWNER_URL;
if (!url) {
  console.error("TEND247_DB_OWNER_URL is not set (see .env.example).");
  process.exit(1);
}
const sql = createSql(url, { max: 1 });
try {
  const config = loadConfig({ TEND247_SESSION_SECRET: "x".repeat(32), ...process.env });
  const w: WorkerDeps = {
    sql,
    config,
    email: new DisabledEmailSender(),
    fetch: (input, init) => fetch(input, init),
    now: () => new Date(),
    origin: config.publicUrl ?? "http://localhost",
    // Nightly export jobs are (re)created by the Worker's cron when its BACKUPS bucket is bound.
  };
  const r = await rebuildAfterRestore(w);
  console.log(`rebuilt ${r.tenants} workspace(s): ${r.clocks} SLA timer(s) re-armed, ${r.events} undelivered event(s) re-queued`);
} finally {
  await sql.end();
}
