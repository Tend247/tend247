// npm run workspace:import -- --in <bundle> --slug <new-slug> [--name "New name"]
// Load a workspace bundle (from the admin download or workspace:export) as a NEW workspace.
// Every id is replaced, so a bundle can be imported next to its original. Afterwards: SLA
// timers are re-armed; set inbound email addresses again (they are unique per deployment) and
// copy attachment files (keys t/<workspace id>/...) if you need them.
import { readFileSync } from "node:fs";
import { createSql } from "../src/worker/db/client.ts";
import { decodeWorkspace, importWorkspace } from "../src/worker/workspace/bundle.ts";
import { loadDotEnv } from "./lib/dotenv.ts";
import { parseArgs, str } from "./lib/args.ts";
import { assertRlsApplies } from "./lib/safety.ts";

loadDotEnv();
const { flags } = parseArgs(process.argv.slice(2));
const url = process.env.TEND247_DB_OWNER_URL;
const file = str(flags.in);
const slug = str(flags.slug);
if (!url || !file || !slug) {
  console.error('usage: npm run workspace:import -- --in <bundle> --slug <new-slug> [--name "Name"]   (needs TEND247_DB_OWNER_URL)');
  process.exit(1);
}
const sql = createSql(url, { max: 1 });
try {
  await assertRlsApplies(sql);
  const data = await decodeWorkspace(new Uint8Array(readFileSync(file)));
  const [taken] = await sql`select 1 from tenants where slug = ${slug}`;
  if (taken) throw new Error(`A workspace with slug "${slug}" already exists`);
  const result = await importWorkspace(sql, data, { slug, name: str(flags.name), disableWebhooks: true });
  console.log(`imported "${data.header.workspace.name}" as ${slug} (${result.tenantId}): ${result.counts.records ?? 0} records, ${result.counts.users ?? 0} people`);
  if (result.counts.webhook_endpoints) console.log("Webhook endpoints were imported switched off; turn them on under Admin > Webhooks once their URLs are right.");
  if (result.missingFiles) console.log(`${result.missingFiles} attachment file(s) were not copied; copy them from the source bucket if needed.`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
