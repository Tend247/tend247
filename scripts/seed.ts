// npm run db:seed — create the Fernhollow Foods sample workspace (a made-up maker of sauces,
// spice blends and cold brew): the four starter templates with teams, a plant calendar,
// automation, inbound addresses and a few dozen records in flight. Idempotent: it does nothing
// if the workspace already exists. The same builder makes the public demo's golden copy.
import { createSql, withTenant } from "../src/worker/db/client.ts";
import { buildFernhollow } from "../src/worker/demo/fernhollow.ts";
import { loadDotEnv } from "./lib/dotenv.ts";

loadDotEnv();
const url = process.env.TEND247_DB_OWNER_URL;
if (!url) {
  console.error("TEND247_DB_OWNER_URL is not set (see .env.example).");
  process.exit(1);
}
const slug = process.env.TEND247_SEED_SLUG ?? "fernhollow";
const sql = createSql(url, { max: 1 });

try {
  const [existing] = await sql`select id from tenants where slug = ${slug}`;
  if (existing) {
    console.log(`workspace "${slug}" already exists; nothing to do`);
  } else {
    const [t] = await sql<{ id: string }[]>`
      insert into tenants (slug, name, settings) values (${slug}, 'Fernhollow Foods', ${sql.json({ timezone: "America/Chicago" })}) returning id`;
    await withTenant(sql, t!.id, (tx) => buildFernhollow(tx, t!.id, { inbound: true }));
    console.log(`created workspace "${slug}". Sign in as admin@fernhollow.test (dev login) to explore.`);
  }
} finally {
  await sql.end();
}
