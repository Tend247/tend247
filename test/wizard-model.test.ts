// The setup wizard's model: what it builds must be a template the server accepts and installs,
// and templates loaded into it must come back out equivalent.
import { describe, expect, it, beforeAll } from "vitest";
import { templateSchema } from "../src/worker/templates/definition.ts";
import { TEMPLATES } from "../src/worker/templates/catalog.ts";
import {
  agileTypes,
  blankState,
  buildTransitions,
  fromDefinition,
  fromMinutes,
  newField,
  newPolicy,
  projectKeyFrom,
  slug,
  stepForIssue,
  toDefinition,
  toMinutes,
  type TemplateDefinition,
} from "../src/web/pages/admin/wizard/model.ts";
import { appSql, makeApp, createWorkspace, Client } from "./helpers.ts";

const sql = appSql();
const { app } = makeApp(sql);

describe("setup wizard model", () => {
  let admin: Client;
  beforeAll(async () => {
    const ws = await createWorkspace(sql);
    admin = await new Client(app).signIn(ws.admin.email, ws.slug);
  });

  it("makes keys from what people type", () => {
    expect(slug("Invoice number")).toBe("invoice_number");
    expect(slug("2nd approver", "field")).toBe("field_2nd_approver");
    expect(slug("Café crème")).toBe("cafe_creme");
    expect(slug("!!!", "status")).toBe("status");
    expect(projectKeyFrom("Facilities requests")).toBe("FR");
    expect(projectKeyFrom("Facilities")).toBe("FAC");
    expect(projectKeyFrom("3D printing lab")).toBe("PL");
  });

  it("converts durations, counting working days as 8 hours", () => {
    expect(toMinutes({ value: "4", unit: "hours" }, true)).toBe(240);
    expect(toMinutes({ value: "3", unit: "days" }, true)).toBe(1440);
    expect(toMinutes({ value: "1", unit: "days" }, false)).toBe(1440);
    expect(toMinutes({ value: "", unit: "days" }, false)).toBeNull();
    expect(fromMinutes(1440, true)).toEqual({ value: "3", unit: "days" });
    expect(fromMinutes(90, false)).toEqual({ value: "90", unit: "minutes" });
  });

  it("builds a valid template from scratch, which installs and takes requests", async () => {
    const s = blankState();
    s.project.name = "Facilities requests";
    s.project.key = projectKeyFrom(s.project.name);
    s.team = "Maintenance";
    const type = s.types[0]!;
    type.name = "Repair";
    type.key = "repair";
    type.fields.push({ ...newField("text", []), key: "location", label: "Location", required: true });
    type.fields.push({ ...newField("select", ["location"]), key: "urgency", label: "Urgency", choices: "Today\nThis week, please\nToday" });
    type.rules.done = { approval: false, required: ["location", "nonexistent"] };
    type.rules.in_progress = { approval: true, required: [] };
    s.sla.enabled = true;
    s.sla.policies.push(newPolicy());
    s.sla.pauseStatuses = ["in_progress", "gone"];

    const def = toDefinition(s);
    const parsed = templateSchema.parse(def);
    const wf = parsed.recordTypes[0]!.workflow;
    expect(wf.transitions.map((t) => [t.key, t.from, t.to])).toEqual([
      ["to_in_progress", ["new"], "in_progress"],
      ["to_done", ["new", "in_progress"], "done"],
      ["reopen", ["done"], "in_progress"],
    ]);
    expect(wf.transitions[0]).toMatchObject({ approval: { approvers: ["$approvers"] }, actions: [{ type: "assign_self" }] });
    expect(wf.transitions[1]!.requiredFields).toEqual(["location"]);
    expect(wf.transitions[2]!.roles).toContain("requester");
    expect(parsed.recordTypes[0]!.fields[1]!.options).toEqual({ choices: [{ value: "today", label: "Today" }, { value: "this_week_please", label: "This week, please" }] });
    expect(parsed.sla!.pauseStatuses).toEqual(["in_progress"]);
    expect(parsed.sla!.policies[0]).toMatchObject({ firstResponseMinutes: 240, resolutionMinutes: 1440, businessHours: true });

    const r = await admin.post("/api/admin/templates/install", { definition: def });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const rec = await admin.post("/api/records", { recordTypeId: r.json.recordTypeId, title: "Leaking tap", custom: { location: "Break room", urgency: "today" } });
    expect(rec.status, JSON.stringify(rec.json)).toBe(201);
  });

  it("builds an agile project with shared steps and an epic type", async () => {
    const s = blankState();
    s.project = { ...s.project, name: "Mobile app", key: "MOB", agile: true, requesterAccess: false };
    s.types = agileTypes();
    const def = toDefinition(s);
    templateSchema.parse(def);
    expect(def.recordTypes.map((t) => [t.key, t.isEpic])).toEqual([
      ["story", false],
      ["bug", false],
      ["task", false],
      ["epic", true],
    ]);
    // Every work type shares the story's board columns; the epic keeps its own.
    expect(new Set(def.recordTypes.slice(0, 3).map((t) => JSON.stringify(t.workflow.statuses))).size).toBe(1);
    expect(def.recordTypes[3]!.workflow.statuses.map((x) => x.key)).toEqual(["open", "in_progress", "done"]);
    expect(def.recordTypes[0]!.workflow.transitions.every((t) => t.from.length === 0)).toBe(true);
    const r = await admin.post("/api/admin/templates/install", { definition: def });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.project.agile).toBe(true);
  });

  it("an epic flag means nothing outside an agile project", () => {
    const s = blankState();
    s.project = { ...s.project, name: "Ops", key: "OPS" };
    s.types[0]!.isEpic = true;
    expect(toDefinition(s).recordTypes[0]!.isEpic).toBe(false);
  });

  it("round-trips every built-in template", async () => {
    for (const { key, definition } of TEMPLATES) {
      const state = fromDefinition(definition as unknown as TemplateDefinition);
      const out = templateSchema.parse(toDefinition(state));
      expect(out.project, key).toEqual(definition.project);
      expect(out.sla ?? null, key).toEqual(definition.sla ?? null);
      expect(out.automation, key).toEqual(definition.automation);
      for (const [i, rt] of definition.recordTypes.entries()) {
        const got = out.recordTypes[i]!;
        expect(got.fields, `${key}.${rt.key}`).toEqual(rt.fields);
        expect(got.workflow.statuses, `${key}.${rt.key}`).toEqual(rt.workflow.statuses);
        // Same moves between the same statuses, with the same approvals.
        const moves = (w: typeof rt.workflow) => w.transitions.map((t) => `${t.from.join("|")}>${t.to}${t.approval ? " (approval)" : ""}`).sort();
        expect(moves(got.workflow), `${key}.${rt.key}`).toEqual(moves(rt.workflow));
      }
      const check = await admin.post("/api/admin/templates/check", { definition: toDefinition(state), options: { projectKey: `R${key.replace(/_/g, "").slice(0, 5).toUpperCase()}` } });
      expect(check.status, `${key}: ${JSON.stringify(check.json)}`).toBe(200);
    }
  });

  it("keeps a template's custom moves when statuses change", () => {
    const ite = TEMPLATES.find((t) => t.key === "it_enhancements")!.definition as unknown as TemplateDefinition;
    const state = fromDefinition(ite);
    const t = state.types[0]!;
    expect(t.flow).toBe("custom");
    t.statuses = t.statuses.filter((x) => x.key !== "declined");
    t.statuses.splice(3, 0, { uid: "x", key: "testing", locked: false, name: "Testing", category: "in_progress" });
    const moves = buildTransitions(t, ["system", "business_value", "target_date"]);
    expect(moves.some((m) => m.to === "declined")).toBe(false);
    expect(moves.find((m) => m.to === "testing")).toMatchObject({ from: [] });
    expect(moves.find((m) => m.key === "approve")).toMatchObject({ approval: { approvers: ["$approvers"] }, requiredFields: ["business_value"] });
  });

  it("points server problems at the right step", () => {
    expect(stepForIssue("projectKey")).toBe(1);
    expect(stepForIssue("recordTypes.0.fields.2.options")).toBe(2);
    expect(stepForIssue("recordTypes.1.workflow.transitions.0.requiredFields")).toBe(3);
    expect(stepForIssue("sla.policies.0.name")).toBe(4);
  });
});
