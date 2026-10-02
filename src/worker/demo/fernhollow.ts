// Fernhollow Foods, a made-up maker of sauces, spice blends and cold brew: the sample workspace
// behind `npm run db:seed` and the public demo's golden copy. The four service queues are the
// starter templates, installed through the template service; on top of them come people,
// teams, a plant calendar, automation and a few dozen records in flight. A fifth project, the
// wholesale ordering app, is an agile team mid-sprint: two finished sprints, one running, a
// planned one, epics and a ranked backlog.
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
import { completeSprint, createSprint, planRecord, startSprint } from "../agile/service.ts";
import { touchSprint } from "../agile/snapshots.ts";
import { updateRecord } from "../records/service.ts";

/** Bump when the sample data changes: the demo rebuilds its golden copy and pool. */
export const FERNHOLLOW_SEED_VERSION = 2;

const DAY = 86_400_000;

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
  projects: { hr: string; itsd: string; ite: string; fin: string; app: string };
  types: { hr: string; itsd: string; ite: string; fin: string; app: string };
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

  const app = await buildOrderingApp(tx, as(admin), { dana: as(dana), lee: as(lee) }, productEng.id);

  // The workspace starts quiet: seed activity sends no notifications or emails.
  await tx`update outbox set delivered_at = now() where delivered_at is null`;
  await tx`delete from work_signals where tenant_id = ${tenantId}`;

  return {
    adminId: admin.id,
    projects: { hr: hr.project.id, itsd: itsd.project.id, ite: ite.project.id, fin: fin.project.id, app: app.projectId },
    types: { hr: hr.recordTypeId, itsd: itsdType, ite: ite.recordTypeId, fin: finType, app: app.storyType },
  };
}

/**
 * The wholesale ordering app team: sprints 1 and 2 finished, sprint 3 six days into two weeks
 * with a burndown that has moved (work done, a bug added, a story re-estimated), sprint 4
 * planned, and a ranked backlog under three epics.
 */
async function buildOrderingApp(tx: Tx, admin: Actor, people: { dana: Actor; lee: Actor }, teamId: string) {
  const { dana, lee } = people;
  const installed = await installTemplate(tx, admin, "agile_team", { projectKey: "APP", projectName: "Wholesale Ordering App", teamId });
  await updateProject(tx, admin, installed.project.id, { description: "The app grocery buyers use to reorder Fernhollow products. Planned in two-week sprints." });
  const t = installed.recordTypeIds as Record<"story" | "bug" | "task" | "epic", string>;
  const now = Date.now();
  const at = (days: number) => new Date(now + days * DAY);

  const make = async (by: Actor, type: keyof typeof t, title: string, points: number | null, extra: Record<string, unknown> = {}) =>
    createRecord(tx, by, { recordTypeId: t[type], title, storyPoints: points, ...extra });
  const go = async (by: Actor, key: string, to: "todo" | "in_progress" | "in_review" | "done" | "open") => {
    const r = (await loadRecord(tx, by, key, { lock: true }))!;
    return runTransition(tx, by, r, `to_${to}`, {});
  };
  const plan = (key: string, sprintId: string | null) => planRecord(tx, dana, key, { sprintId });

  const reorder = await make(dana, "epic", "Wholesale reorder in two taps", null, { description: "Buyers reorder their usual products without calling the sales desk." });
  const tracking = await make(dana, "epic", "Delivery tracking for buyers", null, { description: "Where is my order? Answered in the app, not by phone." });
  const accounts = await make(dana, "epic", "Buyer accounts and invoices", null);
  await go(dana, reorder.key, "in_progress");
  await go(dana, accounts.key, "in_progress");
  const E = { reorder: reorder.id, tracking: tracking.id, accounts: accounts.id };

  // ---------------------------------------------------------------- sprint 1 (finished)
  const s1 = await createSprint(tx, dana, installed.project.id, { goal: "Buyers can sign in and reorder" });
  const s1items = [
    await make(lee, "story", "Buyers sign in with a magic link", 3, { epicId: E.accounts, assigneeId: lee.userId }),
    await make(dana, "story", "Show the last order on the home screen", 5, { epicId: E.reorder, assigneeId: dana.userId }),
    await make(lee, "story", "Reorder a past order as it was", 8, { epicId: E.reorder, assigneeId: lee.userId }),
    await make(lee, "task", "Set up error reporting for the app", 2, { assigneeId: lee.userId }),
    await make(dana, "bug", "Prices show without tax on iPad", 3, { custom: { severity: "minor" }, assigneeId: dana.userId }),
  ];
  for (const r of s1items) await plan(r.key, s1.id);
  await startSprint(tx, dana, s1.id, { startAt: at(-34), weeks: 2 });
  for (const [i, r] of s1items.slice(0, 4).entries()) {
    await go(r.assigneeId === dana.userId ? dana : lee, r.key, "done");
    await touchSprint(tx, s1.id, at(-32 + i * 3));
  }
  await completeSprint(tx, dana, s1.id, {});

  // ---------------------------------------------------------------- sprint 2 (finished)
  const s2 = await createSprint(tx, dana, installed.project.id, { goal: "Edit before reordering; invoices in the app" });
  const carried = s1items[4]!;
  const s2items = [
    carried,
    await make(dana, "story", "Edit quantities before reordering", 5, { epicId: E.reorder, assigneeId: dana.userId }),
    await make(lee, "story", "Download invoices as PDF", 5, { epicId: E.accounts, assigneeId: lee.userId }),
    await make(dana, "story", "Round order lines to whole case packs", 3, { epicId: E.reorder, assigneeId: dana.userId }),
    await make(lee, "task", "Load test the ordering API", 3, { assigneeId: lee.userId }),
    await make(lee, "story", "Saved delivery addresses", 5, { epicId: E.accounts, assigneeId: lee.userId }),
  ];
  for (const r of s2items) await plan(r.key, s2.id);
  await startSprint(tx, dana, s2.id, { startAt: at(-20), weeks: 2 });
  for (const [i, r] of s2items.slice(0, 5).entries()) {
    await go(r.assigneeId === dana.userId ? dana : lee, r.key, "done");
    await touchSprint(tx, s2.id, at(-18 + i * 2.5));
  }
  await go(lee, s2items[5]!.key, "in_progress");

  // ---------------------------------------------------------------- sprint 3 (running) and 4 (planned)
  const s3 = await createSprint(tx, dana, installed.project.id, {});
  const s4 = await createSprint(tx, dana, installed.project.id, {});
  await completeSprint(tx, dana, s2.id, { moveTo: s3.id }); // saved addresses carry over
  const map = await make(lee, "story", "Track a delivery on a map", 5, { epicId: E.tracking, assigneeId: lee.userId });
  const s3items = [
    map,
    await make(dana, "story", "Delivery window notifications", 5, { epicId: E.tracking }),
    await make(dana, "story", "Reorder reminders by email", 3, { epicId: E.reorder, assigneeId: dana.userId }),
    await make(lee, "bug", "Cold brew products missing from search", 2, { custom: { severity: "critical" }, assigneeId: lee.userId, priority: "high" }),
    await make(lee, "task", "Upgrade the payments SDK", 2, { assigneeId: lee.userId }),
    await make(dana, "story", "Favourite products list", 3, { epicId: E.reorder, assigneeId: dana.userId }),
  ];
  for (const r of s3items) await plan(r.key, s3.id);
  await startSprint(tx, dana, s3.id, { startAt: at(-6), weeks: 2, goal: "Buyers can see where their delivery is" });
  await go(lee, map.key, "in_progress");
  await go(dana, s3items[2]!.key, "done");
  await touchSprint(tx, s3.id, at(-4));
  await go(lee, s3items[3]!.key, "done");
  const added = await make(dana, "bug", "Order total rounds wrong with a discount", 3, { custom: { severity: "major" }, priority: "high" });
  await plan(added.key, s3.id);
  await touchSprint(tx, s3.id, at(-3));
  const fresh = (await loadRecord(tx, lee, map.key))!;
  await updateRecord(tx, lee, map.key, { version: fresh.version, storyPoints: 8 }); // bigger than it looked
  await touchSprint(tx, s3.id, at(-2));
  await go(lee, s3items[4]!.key, "done");
  await touchSprint(tx, s3.id, at(-1));
  await go(dana, s3items[5]!.key, "in_progress");
  await go(dana, s3items[5]!.key, "in_review");
  await touchSprint(tx, s3.id, at(0));

  for (const [title, points, epicId] of [
    ["Show a buyer's credit limit", 3, E.accounts],
    ["Proof-of-delivery photos", 5, E.tracking],
  ] as const) {
    const r = await make(dana, "story", title, points, { epicId });
    await plan(r.key, s4.id);
  }
  // The backlog, in rank order.
  await make(dana, "story", "Delivery ETA in the order list", 3, { epicId: E.tracking });
  await make(dana, "story", "Upload an order from a spreadsheet", 8, { epicId: E.reorder });
  await make(lee, "bug", "Sign-out button hidden on small phones", 1, { custom: { severity: "minor" } });
  await make(dana, "story", "Show allergen information on products", 5);
  await make(dana, "story", "Spanish translation", 8);

  // History reads as it happened: the finished sprints keep their own dates.
  await tx`update sprints set started_at = start_at, completed_at = end_at where id in (${s1.id}, ${s2.id})`;
  return { projectId: installed.project.id, storyType: t.story };
}
