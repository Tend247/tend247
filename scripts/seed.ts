// npm run db:seed — create the Fernhollow Foods sample workspace (a made-up maker of sauces,
// spice blends and cold brew): four starter queues with teams, workflows, layouts, SLAs,
// automation and inbound addresses, and a few dozen records in flight. Idempotent: it does
// nothing if the workspace already exists.
import { createSql, withTenant, type Tx } from "../src/worker/db/client.ts";
import { insertUser } from "../src/worker/users/service.ts";
import { createField, createProject, createRecordType, updateProject } from "../src/worker/config/service.ts";
import { publishDefinition } from "../src/worker/config/versions.ts";
import { createRecord } from "../src/worker/records/service.ts";
import { runTransition } from "../src/worker/records/transitions.ts";
import { loadRecord } from "../src/worker/records/access.ts";
import { createComment, addWatcher } from "../src/worker/comments/service.ts";
import { createTeam } from "../src/worker/teams/service.ts";
import { createRule } from "../src/worker/automation/service.ts";
import type { Actor } from "../src/worker/audit.ts";
import type { WorkflowDefinition } from "../src/worker/workflow/definition.ts";
import { loadDotEnv } from "./lib/dotenv.ts";

loadDotEnv();
const url = process.env.TEND247_DB_OWNER_URL;
if (!url) {
  console.error("TEND247_DB_OWNER_URL is not set (see .env.example).");
  process.exit(1);
}
const slug = process.env.TEND247_SEED_SLUG ?? "fernhollow";
const sql = createSql(url, { max: 1 });

type T = WorkflowDefinition["transitions"][number];
const tr = (key: string, name: string, from: string[], to: string, extra: Partial<T> = {}): T => ({
  key,
  name,
  from,
  to,
  roles: ["admin", "agent"],
  requiredFields: [],
  actions: [],
  ...extra,
});

try {
  const [existing] = await sql`select id from tenants where slug = ${slug}`;
  if (existing) {
    console.log(`workspace "${slug}" already exists; nothing to do`);
  } else {
    const [t] = await sql<{ id: string }[]>`
      insert into tenants (slug, name, settings) values (${slug}, 'Fernhollow Foods', ${sql.json({ timezone: "America/Chicago" })}) returning id`;
    const tenantId = t!.id;
    await withTenant(sql, tenantId, async (tx) => {
      const admin = await insertUser(tx, tenantId, { email: "admin@fernhollow.test", displayName: "Avery Admin", role: "admin" });
      const dana = await insertUser(tx, tenantId, { email: "dana@fernhollow.test", displayName: "Dana R.", role: "agent" });
      const sam = await insertUser(tx, tenantId, { email: "sam@fernhollow.test", displayName: "Sam K.", role: "agent" });
      const lee = await insertUser(tx, tenantId, { email: "lee@fernhollow.test", displayName: "Lee M.", role: "agent" });
      const jo = await insertUser(tx, tenantId, { email: "jo@fernhollow.test", displayName: "Jo (Bottling line)", role: "requester" });
      const pat = await insertUser(tx, tenantId, { email: "pat@fernhollow.test", displayName: "Pat (Warehouse)", role: "requester" });
      const actor: Actor = { tenantId, userId: admin.id, role: "admin" };
      const as = (u: { id: string; role: Actor["role"] }): Actor => ({ tenantId, userId: u.id, role: u.role });

      // ---------------------------------------------------------------- teams and calendar
      const peopleOps = await createTeam(tx, actor, { name: "People Ops", memberIds: [dana.id] });
      const serviceDesk = await createTeam(tx, actor, { name: "Service desk", memberIds: [sam.id, lee.id] });
      const productEng = await createTeam(tx, actor, { name: "Product engineering", memberIds: [dana.id, lee.id] });
      const ap = await createTeam(tx, actor, { name: "Accounts payable", memberIds: [sam.id, dana.id] });
      const [office] = await tx<{ id: string }[]>`
        insert into calendars (tenant_id, name, timezone, hours, holidays)
        values (${tenantId}, 'Plant office hours', 'America/Chicago',
          ${tx.json({ mon: [["08:00", "17:00"]], tue: [["08:00", "17:00"]], wed: [["08:00", "17:00"]], thu: [["08:00", "17:00"]], fri: [["08:00", "17:00"]] })},
          ${tx.json(["2026-11-26", "2026-12-25", "2027-01-01"])})
        returning id`;

      const choices = (...labels: string[]) => ({
        choices: labels.map((l) => ({ value: l.toLowerCase().replace(/[^a-z0-9]+/g, "_"), label: l })),
      });
      async function queue(key: string, name: string, typeKey: string, typeName: string, fields: unknown[]) {
        const p = await createProject(tx, actor, { key, name });
        const rt = await createRecordType(tx, actor, p.id, { key: typeKey, name: typeName });
        for (const f of fields) await createField(tx, actor, rt.id, f);
        return { projectId: p.id, typeId: rt.id };
      }

      // ---------------------------------------------------------------- HR Cases (restricted)
      const hr = await queue("HR", "HR Cases", "hr_case", "HR case", [
        { key: "category", label: "Category", type: "select", required: true, options: choices("Shift swap", "Leave", "Payroll", "Policy question") },
        { key: "site", label: "Site", type: "select", options: choices("Bottling line", "Sauce kitchen", "Warehouse", "Office") },
        { key: "resolution", label: "Resolution", type: "long_text" },
      ]);
      await publishDefinition(tx, actor, "workflow", hr.typeId, {
        initial: "new",
        statuses: [
          { key: "new", name: "New", category: "todo" },
          { key: "in_review", name: "In review", category: "in_progress" },
          { key: "waiting_on_employee", name: "Waiting on employee", category: "in_progress" },
          { key: "resolved", name: "Resolved", category: "done" },
        ],
        transitions: [
          tr("review", "Start review", ["new"], "in_review", { actions: [{ type: "assign_self" }] }),
          tr("ask", "Ask the employee", ["in_review"], "waiting_on_employee"),
          tr("resume", "Resume", ["waiting_on_employee"], "in_review"),
          tr("resolve", "Resolve", ["in_review", "waiting_on_employee"], "resolved", { requiredFields: ["resolution"] }),
          tr("reopen", "Reopen", ["resolved"], "in_review", { roles: ["admin", "agent", "requester"] }),
        ],
      });
      await publishDefinition(tx, actor, "layout", hr.typeId, {
        create: { sections: [{ title: "", fields: ["category", "site", "description"] }] },
        view: { sections: [{ title: "Case", fields: ["category", "site", "priority"] }, { title: "Handling", fields: ["assigneeId", "teamId", "resolution"] }] },
        requiredOnCreate: ["description"],
      });
      await publishDefinition(tx, actor, "sla", hr.projectId, {
        policies: [{ name: "HR standard", match: { priorities: [], recordTypeIds: [] }, firstResponseMinutes: 480, resolutionMinutes: 2400, calendarId: office!.id, warnPercent: 80 }],
        pauseStatuses: ["waiting_on_employee"],
      });
      await updateProject(tx, actor, hr.projectId, { restricted: true, defaultTeamId: peopleOps.id, inbound: { address: "people", recordTypeId: hr.typeId } });

      // ---------------------------------------------------------------- IT Service Desk
      const itsd = await queue("ITSD", "IT Service Desk", "incident", "Incident", [
        { key: "site", label: "Site", type: "select", required: true, options: choices("Bottling line", "Sauce kitchen", "Warehouse", "Office") },
        { key: "asset_tag", label: "Asset tag", type: "text" },
        { key: "resolution", label: "Resolution", type: "long_text" },
      ]);
      await publishDefinition(tx, actor, "workflow", itsd.typeId, {
        initial: "new",
        statuses: [
          { key: "new", name: "New", category: "todo" },
          { key: "in_progress", name: "In progress", category: "in_progress" },
          { key: "waiting_on_requester", name: "Waiting on requester", category: "in_progress" },
          { key: "resolved", name: "Resolved", category: "done" },
        ],
        transitions: [
          tr("start", "Start work", ["new"], "in_progress", { actions: [{ type: "assign_self" }] }),
          tr("ask", "Ask requester", ["in_progress"], "waiting_on_requester"),
          tr("resume", "Resume", ["waiting_on_requester"], "in_progress"),
          tr("resolve", "Resolve", ["new", "in_progress", "waiting_on_requester"], "resolved", { requiredFields: ["resolution"] }),
          tr("reopen", "Reopen", ["resolved"], "in_progress", { roles: ["admin", "agent", "requester"] }),
        ],
      });
      await publishDefinition(tx, actor, "sla", itsd.projectId, {
        policies: [
          { name: "Line down", match: { priorities: ["urgent"], recordTypeIds: [] }, firstResponseMinutes: 30, resolutionMinutes: 240, calendarId: null, warnPercent: 75 },
          { name: "Standard", match: { priorities: [], recordTypeIds: [] }, firstResponseMinutes: 240, resolutionMinutes: 1620, calendarId: office!.id, warnPercent: 80 },
        ],
        pauseStatuses: ["waiting_on_requester"],
      });
      await updateProject(tx, actor, itsd.projectId, { defaultTeamId: serviceDesk.id, assignment: "round_robin", inbound: { address: "it", recordTypeId: itsd.typeId } });

      // ---------------------------------------------------------------- IT Enhancements (approval)
      const ite = await queue("ITE", "IT Enhancements", "change_request", "Change request", [
        { key: "system", label: "System", type: "select", required: true, options: choices("Recipe system", "ERP", "Label printing", "Website") },
        { key: "business_value", label: "Business value", type: "long_text" },
        { key: "target_date", label: "Target date", type: "date" },
      ]);
      await publishDefinition(tx, actor, "workflow", ite.typeId, {
        initial: "proposed",
        statuses: [
          { key: "proposed", name: "Proposed", category: "todo" },
          { key: "approved", name: "Approved", category: "in_progress" },
          { key: "in_development", name: "In development", category: "in_progress" },
          { key: "shipped", name: "Shipped", category: "done" },
          { key: "declined", name: "Declined", category: "done" },
        ],
        transitions: [
          tr("approve", "Approve", ["proposed"], "approved", { requiredFields: ["business_value"], approval: { mode: "any", approvers: [dana.id, admin.id] } }),
          tr("decline", "Decline", ["proposed"], "declined"),
          tr("build", "Start development", ["approved"], "in_development", { actions: [{ type: "assign_self" }] }),
          tr("ship", "Ship", ["in_development"], "shipped"),
        ],
      });
      await updateProject(tx, actor, ite.projectId, { defaultTeamId: productEng.id });

      // ---------------------------------------------------------------- AP Requests (approval, restricted)
      const fin = await queue("FIN", "AP Requests", "invoice_exception", "Invoice exception", [
        { key: "vendor", label: "Vendor", type: "text", required: true },
        { key: "invoice_number", label: "Invoice number", type: "text" },
        { key: "amount", label: "Amount", type: "currency", options: { currency: "USD" } },
        { key: "reason", label: "Reason", type: "select", options: choices("Price mismatch", "Quantity mismatch", "Missing PO", "Duplicate") },
      ]);
      await publishDefinition(tx, actor, "workflow", fin.typeId, {
        initial: "new",
        statuses: [
          { key: "new", name: "New", category: "todo" },
          { key: "investigating", name: "Investigating", category: "in_progress" },
          { key: "awaiting_vendor", name: "Awaiting vendor", category: "in_progress" },
          { key: "approved_for_payment", name: "Approved for payment", category: "in_progress" },
          { key: "paid", name: "Paid", category: "done" },
          { key: "voided", name: "Voided", category: "done" },
        ],
        transitions: [
          tr("investigate", "Investigate", ["new"], "investigating", { actions: [{ type: "assign_self" }] }),
          tr("wait_vendor", "Wait for vendor", ["investigating"], "awaiting_vendor"),
          tr("resume", "Resume", ["awaiting_vendor"], "investigating"),
          tr("approve_payment", "Approve payment", ["investigating"], "approved_for_payment", { requiredFields: ["amount"], approval: { mode: "any", approvers: [dana.id, admin.id] } }),
          tr("pay", "Mark paid", ["approved_for_payment"], "paid"),
          tr("void", "Void", ["new", "investigating", "awaiting_vendor"], "voided"),
        ],
      });
      await publishDefinition(tx, actor, "layout", fin.typeId, {
        create: { sections: [{ title: "Invoice", fields: ["vendor", "invoice_number", "amount", "reason", "description"] }] },
        view: { sections: [{ title: "Invoice", fields: ["vendor", "invoice_number", "amount", "reason"] }, { title: "Handling", fields: ["priority", "assigneeId", "teamId"] }] },
        requiredOnCreate: ["amount"],
      });
      await publishDefinition(tx, actor, "sla", fin.projectId, {
        policies: [{ name: "AP standard", match: { priorities: [], recordTypeIds: [] }, firstResponseMinutes: 540, resolutionMinutes: 2700, calendarId: office!.id, warnPercent: 80 }],
        pauseStatuses: ["awaiting_vendor", "approved_for_payment"],
      });
      await updateProject(tx, actor, fin.projectId, { restricted: true, defaultTeamId: ap.id, inbound: { address: "ap", recordTypeId: fin.typeId } });

      // ---------------------------------------------------------------- automation
      await createRule(tx, actor, {
        name: "Line-down incidents alert the whole service desk",
        projectId: itsd.projectId,
        trigger: "record.created",
        conditions: [{ field: "priority", op: "eq", value: "urgent" }],
        actions: [{ type: "notify", to: ["team"], message: "{{key}} is urgent: {{title}}" }],
      });
      await createRule(tx, actor, {
        name: "Duplicate invoices go straight to Sam",
        projectId: fin.projectId,
        trigger: "record.created",
        conditions: [{ field: "custom.reason", op: "eq", value: "duplicate" }],
        actions: [
          { type: "assign", userId: sam.id },
          { type: "comment", body: "Routed automatically: check the earlier invoice before paying {{key}}.", internal: true },
        ],
      });

      // ---------------------------------------------------------------- records in flight
      const rec = (by: Actor, recordTypeId: string, title: string, custom: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
        createRecord(tx, by, { recordTypeId, title, custom, ...extra });
      const move = async (by: Actor, key: string, transition: string, fields?: Record<string, unknown>) => {
        const r = (await loadRecord(tx as Tx, by, key, { lock: true }))!;
        return runTransition(tx, by, r, transition, fields ? { fields } : {});
      };

      const f1 = await rec(as(sam), fin.typeId, "Missing PO on label stock order", { vendor: "PrintWorks", amount: 640, reason: "missing_po" }, { assigneeId: lee.id });
      const f2 = await rec(as(sam), fin.typeId, "Short shipment: glass bottles", { vendor: "ClearGlass", invoice_number: "CG-7781", amount: 3377.2, reason: "quantity_mismatch" }, { priority: "high" });
      const f3 = await rec(as(lee), fin.typeId, "Price mismatch: smoked paprika", { vendor: "Saffron Ltd", amount: 2104.75, reason: "price_mismatch" }, { assigneeId: dana.id, priority: "urgent" });
      await rec(as(lee), fin.typeId, "Duplicate invoice for jar lids", { vendor: "LidCo", amount: 918, reason: "duplicate" }, { priority: "low" });
      const f5 = await rec(as(lee), fin.typeId, "Freight overcharge on cold brew pallets", { vendor: "Northline Haul", amount: 1265.4, reason: "price_mismatch" });
      const f6 = await rec(as(sam), fin.typeId, "Invoice exception: chili pepper supplier", { vendor: "Ancho & Co", invoice_number: "AC-20931", amount: 4820, reason: "price_mismatch" }, { priority: "high" });
      await move(as(sam), f2.key, "investigate");
      await move(as(sam), f2.key, "wait_vendor");
      await createComment(tx, as(sam), f2.key, { body: "Asked ClearGlass for a credit note for the 240 missing bottles.", internal: false });
      await move(as(dana), f3.key, "investigate");
      await createComment(tx, as(dana), f3.key, { body: "Contract price is $18.40/kg; invoice says $21.10. Checking with purchasing.", internal: true, mentions: [sam.id] });
      await move(as(sam), f6.key, "investigate");
      await move(as(sam), f6.key, "approve_payment"); // waits for Dana or Avery
      await move(as(lee), f5.key, "investigate");
      await move(as(lee), f5.key, "void");
      await addWatcher(tx, tenantId, f1.id, dana.id);

      const i1 = await rec(as(jo), itsd.typeId, "Label printer down on the sauce line", { site: "sauce_kitchen", asset_tag: "LP-0042" }, { priority: "urgent" });
      const i2 = await rec(as(pat), itsd.typeId, "Scanner not reading pallet barcodes", { site: "warehouse", asset_tag: "SC-0117" });
      const i3 = await rec(as(jo), itsd.typeId, "Can't print shift roster from the break-room PC", { site: "bottling_line" });
      await rec(as(pat), itsd.typeId, "New starter needs a warehouse tablet", { site: "warehouse" }, { priority: "low" });
      await move(as(lee), i1.key, "start");
      await createComment(tx, as(lee), i1.key, { body: "On my way with a spare print head.", internal: false });
      await move(as(sam), i2.key, "start");
      await createComment(tx, as(sam), i2.key, { body: "Which dock is it? The firmware on dock 3 scanners is a version behind.", internal: false });
      await move(as(sam), i2.key, "ask");
      await move(as(lee), i3.key, "start");
      await move(as(lee), i3.key, "resolve", { custom: { resolution: "Re-added the shared printer; roster prints again." } });

      const e1 = await rec(as(dana), ite.typeId, "Add an allergen field to the recipe system", { system: "recipe_system", business_value: "Labels must list allergens; today they are typed by hand." });
      await rec(as(lee), ite.typeId, "Print batch codes on cold brew labels", { system: "label_printing", target_date: "2026-12-01" });
      await move(as(lee), e1.key, "approve"); // Dana or Avery approves

      const h1 = await rec(as(jo), hr.typeId, "Shift swap request for Saturday", { category: "shift_swap", site: "bottling_line" }, { description: "Swap with Morgan for the 6am bottling shift." });
      await rec(as(pat), hr.typeId, "Question about overtime policy", { category: "policy_question", site: "warehouse" }, { description: "Does Saturday overtime count toward the monthly cap?" });
      await move(as(dana), h1.key, "review");
      await createComment(tx, as(dana), h1.key, { body: "Morgan confirmed; approving the swap.", internal: false });

      // The demo starts quiet: seed activity does not send notifications or emails.
      await tx`update outbox set delivered_at = now() where delivered_at is null`;
      await tx`delete from work_signals where tenant_id = ${tenantId}`;
    });
    console.log(`created workspace "${slug}". Sign in as admin@fernhollow.test (dev login) to explore.`);
  }
} finally {
  await sql.end();
}
