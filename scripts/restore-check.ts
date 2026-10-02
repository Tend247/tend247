// npm run restore:check -- --bundle <file>            a workspace bundle (admin download or workspace:export)
// npm run restore:check -- --export <dir> [--key K]   a nightly export copied out of the BACKUPS bucket
//                                                     (the folder holding manifest.json)
// Proves a backup can be restored: loads it as a NEW, temporary workspace in the database at
// TEND247_DB_OWNER_URL, checks every table's row count against the backup, re-arms SLA
// timers, then deletes the copy (keep it with --keep). Exits non-zero if anything is off, so it
// can run on a schedule (see .github/workflows/restore-drill.yml).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createSql } from "../src/worker/db/client.ts";
import { countRows, decodeWorkspace, deleteWorkspace, importWorkspace, readWorkspace, workspaceFromExport, type WorkspaceData } from "../src/worker/workspace/bundle.ts";
import { loadDotEnv } from "./lib/dotenv.ts";
import { parseArgs, str } from "./lib/args.ts";
import { assertRlsApplies } from "./lib/safety.ts";

loadDotEnv();
const { flags } = parseArgs(process.argv.slice(2));
const url = process.env.TEND247_DB_OWNER_URL;
const bundle = str(flags.bundle);
const exportDir = str(flags.export);
if (!url || (!bundle && !exportDir)) {
  console.error("usage: npm run restore:check -- --bundle <file> | --export <dir> [--key <base64>] [--keep]   (needs TEND247_DB_OWNER_URL)");
  process.exit(1);
}

const sql = createSql(url, { max: 1 });
const started = Date.now();
try {
  await assertRlsApplies(sql);
  let data: WorkspaceData;
  if (bundle) {
    data = await decodeWorkspace(new Uint8Array(readFileSync(bundle)));
  } else {
    const manifest = JSON.parse(readFileSync(join(exportDir!, "manifest.json"), "utf8"));
    // Part keys are bucket paths (exports/<slug>/<date>/<file>); the files sit next to the manifest.
    data = await workspaceFromExport(
      manifest,
      async (key) => new Uint8Array(readFileSync(join(exportDir!, key.split("/").pop()!))),
      str(flags.key) ?? process.env.TEND247_BACKUP_ENCRYPTION_KEY ?? null,
    );
  }
  const expected = countRows(data);
  const slug = `restore-check-${new Date().toISOString().slice(0, 19).replace(/[^0-9]/g, "")}`;
  console.log(`restoring "${data.header.workspace.name}" (${data.header.exportedAt}, schema ${data.header.schema ?? "unknown"}) as ${slug}…`);
  // Inert: the copy's webhooks and automation are off and no SLA timers run, so it never
  // notifies or calls anyone while it exists.
  const result = await importWorkspace(sql, data, { slug, name: `${data.header.workspace.name} (restore check)`, inert: true });
  const restored = countRows(await readWorkspace(sql, result.tenantId));
  const problems = Object.keys(expected).filter((t) => expected[t] !== restored[t]);
  for (const t of Object.keys(expected)) {
    if (expected[t] || restored[t]) console.log(`  ${expected[t] === restored[t] ? "ok " : "BAD"} ${t.padEnd(18)} ${restored[t]} / ${expected[t]}`);
  }
  if (flags.keep) console.log(`kept the restored copy as workspace "${slug}"`);
  else await deleteWorkspace(sql, result.tenantId);
  if (problems.length) {
    console.error(`restore check FAILED: ${problems.join(", ")} did not match`);
    process.exitCode = 1;
  } else {
    const rows = Object.values(expected).reduce((a, b) => a + b, 0);
    console.log(`restore check passed: ${rows} rows in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  }
} catch (err) {
  console.error(`restore check FAILED: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
