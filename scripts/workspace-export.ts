// npm run workspace:export -- --workspace <slug> [--out file.tend247.ndjson.gz]
// Write a whole workspace (configuration, people, records, history) as a bundle that
// `npm run workspace:import` can load into any Tend 24/7 deployment. Sessions, tokens and other
// secrets are never included. Attachment files stay in R2; copy the bucket separately.
import { writeFileSync } from "node:fs";
import { createSql } from "../src/worker/db/client.ts";
import { countRows, encodeWorkspace, readWorkspace } from "../src/worker/workspace/bundle.ts";
import { loadDotEnv } from "./lib/dotenv.ts";
import { parseArgs, str } from "./lib/args.ts";
import { assertRlsApplies } from "./lib/safety.ts";

loadDotEnv();
const { flags } = parseArgs(process.argv.slice(2));
const url = process.env.TEND247_DB_OWNER_URL;
const slug = str(flags.workspace);
if (!url || !slug) {
  console.error("usage: npm run workspace:export -- --workspace <slug> [--out file]   (needs TEND247_DB_OWNER_URL)");
  process.exit(1);
}
const sql = createSql(url, { max: 1 });
try {
  await assertRlsApplies(sql);
  const [t] = await sql<{ id: string }[]>`select id from tenants where slug = ${slug}`;
  if (!t) throw new Error(`No workspace with slug "${slug}"`);
  const data = await readWorkspace(sql, t.id);
  const out = str(flags.out) ?? `${slug}-${data.header.exportedAt.slice(0, 10)}.tend247.ndjson.gz`;
  writeFileSync(out, await encodeWorkspace(data));
  const counts = countRows(data);
  console.log(`wrote ${out}: ${counts.records} records, ${counts.users} people, ${Object.values(counts).reduce((a, b) => a + b, 0)} rows`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
