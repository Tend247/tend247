// Fernhollow Foods, a made-up maker of sauces, spice blends and cold brew: the sample workspace
// behind `npm run db:seed` and the public demo's golden copy. The four queues are the four
// starter templates, installed through the template service; on top of them come people,
// teams, a plant calendar, automation and a few dozen records in flight.
import type { Tx } from "../db/client.ts";
import type { Actor } from "../audit.ts";
import { insertUser } from "../users/service.ts";
import { updateProject } from "../config/service.ts";
import { createRecord } from "../records/service.ts";
import { runTransition } from "../records/transitions.ts";
import { loadRecord } from "../records/access.ts";
import { createComment, addWatcher } from "../comments/service.ts";
import { createTeam } from "../teams/service.ts";
import { createRule } from "../automation/service.ts";
import { installTemplate } from "../templates/install.ts";

/** Bump when the sample data changes: the demo rebuilds its golden copy and pool. */
export const FERNHOLLOW_SEED_VERSION = 1;

/** The demo's role switcher signs in as these people. */
export const PERSONAS = {
  requester: { email: "jo@fernhollow.test", label: "Jo, bottling line (requester)" },
  agent: { email: "sam@fernhollow.test", label: "Sam, service desk (agent)" },
  lead: { email: "dana@fernhollow.test", label: "Dana, team lead and approver" },
  admin: { email: "admin@fernhollow.test", label: "Avery, admin" },
} as const;
export type Persona = keyof typeof PERSONAS;

export interface Fernhollow {
  adminId: string;
  projects: { hr: string; itsd: string; ite: string; fin: string };
  types: { hr: string; itsd: string; ite: string; fin: string };
}

export async function buildFernhollow(tx: Tx, tenantId: string, opts: { inbound?: boolean } = {}): Promise<Fernhollow> {
  const admin = await insertUser(tx, tenantId, { email: PERSONAS.admin.email, displayName: "Avery Admin", role: "admin" });
  const dana = await insertUser(tx, tenantId, { email: PERSONAS.lead.email, displayName: "Dana R.", role: "agent" });
  const sam = await insertUser(tx, tenantId, { email: PERSONAS.agent.email, displayName: "Sam K.", role: "agent" });
  const lee = await insertUser(tx, tenantId, { email: "lee@fernhollow.test", displayName: "Lee M.", role: "agent" });
  const jo = await insertUser(tx, tenantId, { email: PERSONAS.requester.email, displayName: "Jo (Bottling line)", role: "requester" });
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
      ${tx.json(["2026-11-26", "2026-12-25", "2027-01-01", "2027-05-31", "2027-07-05"])})
    returning id`;

  // ---------------------------------------------------------------- the four starter templates
  const approverIds = [dana.id, admin.id];
  const hr = await installTemplate(tx, actor, "hr_cases", { teamId: peopleOps.id, calendarId: office!.id });
  const itsd = await installTemplate(tx, actor, "it_service_desk", { teamId: serviceDesk.id, calendarId: office!.id });
  const ite = await installTemplate(tx, actor, "it_enhancements", { teamId: productEng.id, approverIds });
  const fin = await installTemplate(tx, actor, "ap_requests", { teamId: ap.id, calendarId: office!.id, approverIds });
  if (opts.inbound) {
    // Inbound addresses are unique per deployment, so the demo's copies never claim them.
    await updateProject(tx, actor, hr.project.id, { inbound: { address: "people", recordTypeId: hr.recordTypeId } });
    await updateProject(tx, actor, itsd.project.id, { inbound: { address: "it", recordTypeId: itsd.recordTypeId } });
    await updateProject(tx, actor, fin.project.id, { inbound: { address: "ap", recordTypeId: fin.recordTypeId } });
  }

  // ---------------------------------------------------------------- automation
  await createRule(tx, actor, {
    name: "Line-down incidents alert the whole service desk",
    projectId: itsd.project.id,
    trigger: "record.created",
    conditions: [{ field: "priority", op: "eq", value: "urgent" }],
    actions: [{ type: "notify", to: ["team"], message: "Line-down incident: {{title}}" }],
  });
  await createRule(tx, actor, {
    name: "Duplicate invoices go straight to Sam",
    projectId: fin.project.id,
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
    const r = (await loadRecord(tx, by, key, { lock: true }))!;
    return runTransition(tx, by, r, transition, fields ? { fields } : {});
  };
  const finType = fin.recordTypeId;
  const itsdType = itsd.recordTypeId;

  const f1 = await rec(as(sam), finType, "Missing PO on label stock order", { vendor: "PrintWorks", amount: 640, reason: "missing_po" }, { assigneeId: lee.id });
  const f2 = await rec(as(sam), finType, "Short shipment: glass bottles", { vendor: "ClearGlass", invoice_number: "CG-7781", amount: 3377.2, reason: "quantity_mismatch" }, { priority: "high" });
  const f3 = await rec(as(lee), finType, "Price mismatch: smoked paprika", { vendor: "Saffron Ltd", amount: 2104.75, reason: "price_mismatch" }, { assigneeId: dana.id, priority: "urgent" });
  await rec(as(lee), finType, "Duplicate invoice for jar lids", { vendor: "LidCo", amount: 918, reason: "duplicate" }, { priority: "low" });
  const f5 = await rec(as(lee), finType, "Freight overcharge on cold brew pallets", { vendor: "Northline Haul", amount: 1265.4, reason: "price_mismatch" });
  const f6 = await rec(as(sam), finType, "Invoice exception: chili pepper supplier", { vendor: "Ancho & Co", invoice_number: "AC-20931", amount: 4820, reason: "price_mismatch" }, { priority: "high" });
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

  const i1 = await rec(as(jo), itsdType, "Label printer down on the sauce line", { site: "sauce_kitchen", asset_tag: "LP-0042" }, { priority: "urgent" });
  const i2 = await rec(as(pat), itsdType, "Scanner not reading pallet barcodes", { site: "warehouse", asset_tag: "SC-0117" });
  const i3 = await rec(as(jo), itsdType, "Can't print shift roster from the break-room PC", { site: "bottling_line" });
  await rec(as(pat), itsdType, "New starter needs a warehouse tablet", { site: "warehouse" }, { priority: "low" });
  await rec(as(jo), itsdType, "Bottling line HMI screen flickers", { site: "bottling_line", asset_tag: "HMI-0007" }, { priority: "high" });
  await move(as(lee), i1.key, "start");
  await createComment(tx, as(lee), i1.key, { body: "On my way with a spare print head.", internal: false });
  await move(as(sam), i2.key, "start");
  await createComment(tx, as(sam), i2.key, { body: "Which dock is it? The firmware on dock 3 scanners is a version behind.", internal: false });
  await move(as(sam), i2.key, "ask");
  await move(as(lee), i3.key, "start");
  await move(as(lee), i3.key, "resolve", { custom: { resolution: "Re-added the shared printer; roster prints again." } });

  const e1 = await rec(as(dana), ite.recordTypeId, "Add an allergen field to the recipe system", { system: "recipe_system", business_value: "Labels must list allergens; today they are typed by hand." });
  await rec(as(lee), ite.recordTypeId, "Print batch codes on cold brew labels", { system: "label_printing", target_date: "2026-12-01" });
  await move(as(lee), e1.key, "approve"); // Dana or Avery approves

  const h1 = await rec(as(jo), hr.recordTypeId, "Shift swap request for Saturday", { category: "shift_swap", site: "bottling_line" }, { description: "Swap with Morgan for the 6am bottling shift." });
  await rec(as(pat), hr.recordTypeId, "Question about overtime policy", { category: "policy_question", site: "warehouse" }, { description: "Does Saturday overtime count toward the monthly cap?" });
  await move(as(dana), h1.key, "review");
  await createComment(tx, as(dana), h1.key, { body: "Morgan confirmed; approving the swap.", internal: false });

  // The workspace starts quiet: seed activity sends no notifications or emails.
  await tx`update outbox set delivered_at = now() where delivered_at is null`;
  await tx`delete from work_signals where tenant_id = ${tenantId}`;

  return {
    adminId: admin.id,
    projects: { hr: hr.project.id, itsd: itsd.project.id, ite: ite.project.id, fin: fin.project.id },
    types: { hr: hr.recordTypeId, itsd: itsdType, ite: ite.recordTypeId, fin: finType },
  };
}
