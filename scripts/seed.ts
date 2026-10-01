// npm run db:seed — create the Fernhollow Foods sample workspace (a made-up maker of sauces,
// spice blends and cold brew) with the four starter queues and some records. Idempotent:
// it does nothing if the workspace already exists.
import { createSql, withTenant } from "../src/worker/db/client.ts";
import { insertUser } from "../src/worker/users/service.ts";
import { createField, createProject, createRecordType } from "../src/worker/config/service.ts";
import { createRecord } from "../src/worker/records/service.ts";
import type { Actor } from "../src/worker/audit.ts";
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
    const [t] = await sql<{ id: string }[]>`insert into tenants (slug, name) values (${slug}, 'Fernhollow Foods') returning id`;
    const tenantId = t!.id;
    await withTenant(sql, tenantId, async (tx) => {
      const admin = await insertUser(tx, tenantId, { email: "admin@fernhollow.test", displayName: "Avery Admin", role: "admin" });
      const dana = await insertUser(tx, tenantId, { email: "dana@fernhollow.test", displayName: "Dana R.", role: "agent" });
      const sam = await insertUser(tx, tenantId, { email: "sam@fernhollow.test", displayName: "Sam K.", role: "agent" });
      const lee = await insertUser(tx, tenantId, { email: "lee@fernhollow.test", displayName: "Lee M.", role: "agent" });
      const jo = await insertUser(tx, tenantId, { email: "jo@fernhollow.test", displayName: "Jo (Bottling line)", role: "requester" });
      const actor: Actor = { tenantId, userId: admin.id, role: "admin" };

      async function queue(key: string, name: string, typeKey: string, typeName: string, fields: unknown[]) {
        const p = await createProject(tx, actor, { key, name });
        const rt = await createRecordType(tx, actor, p.id, { key: typeKey, name: typeName });
        for (const f of fields) await createField(tx, actor, rt.id, f);
        return rt.id;
      }
      const choices = (...labels: string[]) => ({
        choices: labels.map((l) => ({ value: l.toLowerCase().replace(/[^a-z0-9]+/g, "_"), label: l })),
      });

      const hr = await queue("HR", "HR Cases", "hr_case", "HR case", [
        { key: "category", label: "Category", type: "select", required: true, options: choices("Shift swap", "Leave", "Payroll", "Policy question") },
        { key: "site", label: "Site", type: "select", options: choices("Bottling line", "Sauce kitchen", "Warehouse", "Office") },
      ]);
      const itsd = await queue("ITSD", "IT Service Desk", "incident", "Incident", [
        { key: "site", label: "Site", type: "select", required: true, options: choices("Bottling line", "Sauce kitchen", "Warehouse", "Office") },
        { key: "asset_tag", label: "Asset tag", type: "text" },
      ]);
      const ite = await queue("ITE", "IT Enhancements", "change_request", "Change request", [
        { key: "system", label: "System", type: "select", required: true, options: choices("Recipe system", "ERP", "Label printing", "Website") },
        { key: "business_value", label: "Business value", type: "long_text" },
        { key: "target_date", label: "Target date", type: "date" },
      ]);
      const fin = await queue("FIN", "AP Requests", "invoice_exception", "Invoice exception", [
        { key: "vendor", label: "Vendor", type: "text", required: true },
        { key: "invoice_number", label: "Invoice number", type: "text" },
        { key: "amount", label: "Amount", type: "currency", options: { currency: "USD" } },
        { key: "reason", label: "Reason", type: "select", options: choices("Price mismatch", "Quantity mismatch", "Missing PO", "Duplicate") },
      ]);

      const rec = (recordTypeId: string, title: string, custom: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
        createRecord(tx, actor, { recordTypeId, title, custom, ...extra });
      await rec(fin, "Missing PO on label stock order", { vendor: "PrintWorks", amount: 640, reason: "missing_po" }, { assigneeId: lee.id });
      await rec(fin, "Short shipment: glass bottles", { vendor: "ClearGlass", amount: 3377.2, reason: "quantity_mismatch" }, { assigneeId: sam.id, priority: "high" });
      await rec(fin, "Price mismatch: smoked paprika", { vendor: "Saffron Ltd", amount: 2104.75, reason: "price_mismatch" }, { assigneeId: dana.id, priority: "urgent" });
      await rec(fin, "Duplicate invoice for jar lids", { vendor: "LidCo", amount: 918, reason: "duplicate" }, { priority: "low" });
      await rec(fin, "Freight overcharge on cold brew pallets", { vendor: "Northline Haul", amount: 1265.4, reason: "price_mismatch" }, { assigneeId: sam.id });
      await rec(fin, "Invoice exception: chili pepper supplier", { vendor: "Ancho & Co", invoice_number: "AC-20931", amount: 4820, reason: "price_mismatch" }, { assigneeId: dana.id, priority: "high" });
      await rec(itsd, "Label printer down on the sauce line", { site: "sauce_kitchen", asset_tag: "LP-0042" }, { assigneeId: lee.id, priority: "urgent", requesterId: jo.id });
      await rec(itsd, "Scanner not reading pallet barcodes", { site: "warehouse", asset_tag: "SC-0117" }, { assigneeId: sam.id });
      await rec(ite, "Add an allergen field to the recipe system", { system: "recipe_system", business_value: "Labels must list allergens; today they are typed by hand." }, { assigneeId: dana.id });
      await rec(hr, "Shift swap request for Saturday", { category: "shift_swap", site: "bottling_line" }, { requesterId: jo.id });
      await rec(hr, "Question about overtime policy", { category: "policy_question", site: "warehouse" });
    });
    console.log(`created workspace "${slug}". Sign in as admin@fernhollow.test (dev login) to explore.`);
  }
} finally {
  await sql.end();
}
