// Phase 1: workflows (statuses, transitions, guards, actions), versioned publish/restore with
// status mapping, and layouts.
import { describe, expect, it, beforeAll } from "vitest";
import { appSql, makeApp, createWorkspace, addUser, Client, setupApProject, type TestWorkspace } from "./helpers.ts";

const sql = appSql();
const { app } = makeApp(sql);

let ws: TestWorkspace;
let admin: Client;
let agent: Client;
let requester: Client;
let requesterId: string;
let agentId: string;
let projectId: string;
let recordTypeId: string;

const WORKFLOW = {
  initial: "new",
  statuses: [
    { key: "new", name: "New", category: "todo" },
    { key: "triage", name: "Triage", category: "todo" },
    { key: "in_progress", name: "In progress", category: "in_progress" },
    { key: "waiting", name: "Waiting", category: "in_progress" },
    { key: "done", name: "Done", category: "done" },
  ],
  transitions: [
    { key: "triage", name: "Triage", from: ["new"], to: "triage" },
    { key: "start", name: "Start", from: ["new", "triage"], to: "in_progress", actions: [{ type: "assign_self" }] },
    { key: "wait", name: "Wait", from: ["in_progress"], to: "waiting" },
    { key: "resolve", name: "Resolve", from: ["in_progress", "waiting"], to: "done", requiredFields: ["reason"] },
    { key: "reopen", name: "Reopen", from: ["done"], to: "in_progress", roles: ["admin", "agent", "requester"] },
  ],
};

beforeAll(async () => {
  ws = await createWorkspace(sql);
  admin = await new Client(app).signIn(ws.admin.email, ws.slug);
  const a = await addUser(sql, ws, "agent");
  agentId = a.id;
  agent = await new Client(app).signIn(a.email, ws.slug);
  const r = await addUser(sql, ws, "requester");
  requesterId = r.id;
  requester = await new Client(app).signIn(r.email, ws.slug);
  ({ projectId, recordTypeId } = await setupApProject(admin, "WF"));
});

async function newRecord(client = agent, extra: Record<string, unknown> = {}) {
  const r = await client.post("/api/records", { recordTypeId, title: "Invoice 88 mismatch", custom: { vendor: "Acme" }, ...extra });
  expect(r.status).toBe(201);
  return r.json.record;
}

describe("default workflow", () => {
  it("every new record type starts on version 1 of the default workflow", async () => {
    const bundle = await admin.get(`/api/admin/config/workflow/${recordTypeId}`);
    expect(bundle.status).toBe(200);
    expect(bundle.json.published.version).toBe(1);
    expect(bundle.json.published.definition.initial).toBe("new");
    const rec = await newRecord();
    expect(rec).toMatchObject({ status: "new", statusCategory: "todo", workflowVersion: 1 });
  });

  it("moves a record along a transition and records it in history", async () => {
    const rec = await newRecord();
    const detail = await agent.get(`/api/records/${rec.key}`);
    expect(detail.json.transitions.map((t: { key: string }) => t.key)).toEqual(["start", "wait", "resolve"]);
    const moved = await agent.post(`/api/records/${rec.key}/transitions`, { transition: "start", version: rec.version });
    expect(moved.status).toBe(200);
    expect(moved.json.record).toMatchObject({ status: "in_progress", statusCategory: "in_progress" });
    const events = await agent.get(`/api/records/${rec.key}/events`);
    expect(events.json.events.at(-1)).toMatchObject({ kind: "transitioned", data: { from: "new", to: "in_progress" } });
  });

  it("refuses transitions that are not available, stale versions and the wrong role", async () => {
    const rec = await newRecord();
    expect((await agent.post(`/api/records/${rec.key}/transitions`, { transition: "reopen" })).status).toBe(409);
    expect((await agent.post(`/api/records/${rec.key}/transitions`, { transition: "nope" })).status).toBe(404);
    expect((await agent.post(`/api/records/${rec.key}/transitions`, { transition: "start", version: 99 })).status).toBe(409);
    const mine = await newRecord(requester);
    expect((await requester.post(`/api/records/${mine.key}/transitions`, { transition: "start" })).status).toBe(403);
  });
});

describe("custom workflow", () => {
  it("validates a draft before saving it", async () => {
    const bad = await admin.put(`/api/admin/config/workflow/${recordTypeId}/draft`, {
      definition: { ...WORKFLOW, initial: "missing", transitions: [{ key: "x", name: "X", from: ["ghost"], to: "done", requiredFields: ["nope"] }] },
    });
    expect(bad.status).toBe(422);
    const fields = bad.json.error.details.issues.map((i: { field: string }) => i.field);
    expect(fields).toEqual(expect.arrayContaining(["initial", "transitions.0.from.0", "transitions.0.requiredFields.0"]));
  });

  it("publishing a version that removes a status in use needs a mapping", async () => {
    const waiting = await newRecord();
    await agent.post(`/api/records/${waiting.key}/transitions`, { transition: "wait" });
    const noWaiting = { ...WORKFLOW, statuses: WORKFLOW.statuses.filter((s) => s.key !== "waiting"), transitions: WORKFLOW.transitions.filter((t) => t.key !== "wait").map((t) => ({ ...t, from: t.from.filter((f) => f !== "waiting") })) };
    expect((await admin.put(`/api/admin/config/workflow/${recordTypeId}/draft`, { definition: noWaiting })).status).toBe(200);
    const refused = await admin.post(`/api/admin/config/workflow/${recordTypeId}/publish`, {});
    expect(refused.status).toBe(422);
    expect(refused.json.error.details.statusesNeedingMap).toEqual([{ key: "waiting", name: "Waiting", count: 1 }]);

    const ok = await admin.post(`/api/admin/config/workflow/${recordTypeId}/publish`, { statusMap: { waiting: "in_progress" } });
    expect(ok.status).toBe(200);
    expect(ok.json.published.version).toBe(2);
    const after = await agent.get(`/api/records/${waiting.key}`);
    expect(after.json.record).toMatchObject({ status: "in_progress", workflowVersion: 2 });
    const events = await agent.get(`/api/records/${waiting.key}/events`);
    expect(events.json.events.at(-1)).toMatchObject({ kind: "status_mapped", data: { from: "waiting", to: "in_progress" } });
  });

  it("publishes the full workflow and enforces guards, required fields and actions", async () => {
    expect((await admin.put(`/api/admin/config/workflow/${recordTypeId}/draft`, { definition: WORKFLOW })).status).toBe(200);
    const pub = await admin.post(`/api/admin/config/workflow/${recordTypeId}/publish`, {});
    expect(pub.json.published.version).toBe(3);

    const rec = await newRecord(admin, { custom: { vendor: "Acme", reason: null } });
    const started = await agent.post(`/api/records/${rec.key}/transitions`, { transition: "start" });
    expect(started.json.record.assigneeId).toBe(agentId); // assign_self action

    const blocked = await agent.post(`/api/records/${rec.key}/transitions`, { transition: "resolve" });
    expect(blocked.status).toBe(422);
    expect(blocked.json.error.details.issues).toEqual([{ field: "custom.reason", message: "Required to resolve" }]);

    const resolved = await agent.post(`/api/records/${rec.key}/transitions`, { transition: "resolve", fields: { custom: { reason: "qty" } } });
    expect(resolved.status).toBe(200);
    expect(resolved.json.record).toMatchObject({ status: "done", statusCategory: "done" });
    expect(resolved.json.record.resolvedAt).not.toBeNull();
  });

  it("lets a requester run a transition opened to requesters, on their own record", async () => {
    const rec = await newRecord(requester);
    await agent.post(`/api/records/${rec.key}/transitions`, { transition: "start" });
    await agent.post(`/api/records/${rec.key}/transitions`, { transition: "resolve", fields: { custom: { reason: "price" } } });
    const config = await requester.get("/api/config");
    const rt = config.json.projects.flatMap((p: any) => p.recordTypes).find((t: any) => t.id === recordTypeId);
    expect(rt.workflow.transitions.map((t: { key: string }) => t.key)).toEqual(["reopen"]);
    const reopened = await requester.post(`/api/records/${rec.key}/transitions`, { transition: "reopen" });
    expect(reopened.status).toBe(200);
    expect(reopened.json.record.resolvedAt).toBeNull();
  });

  it("restores an earlier version as the newest one, and audits it", async () => {
    const restored = await admin.post(`/api/admin/config/workflow/${recordTypeId}/versions/1/restore`, { statusMap: { triage: "new" } });
    expect(restored.status).toBe(200);
    expect(restored.json.published.version).toBe(4);
    expect(restored.json.published.definition.statuses.map((s: { key: string }) => s.key)).toContain("waiting");
    const bundle = await admin.get(`/api/admin/config/workflow/${recordTypeId}`);
    expect(bundle.json.versions.map((v: { version: number; state: string }) => [v.version, v.state])).toEqual([
      [4, "published"],
      [3, "superseded"],
      [2, "superseded"],
      [1, "superseded"],
    ]);
    const audit = await admin.get("/api/admin/audit?limit=5");
    expect(audit.json.entries[0]).toMatchObject({ entity: "workflow", action: "restore" });
    expect((await admin.post(`/api/admin/config/workflow/${recordTypeId}/versions/4/restore`, {})).status).toBe(400);
  });

  it("only admins manage configuration", async () => {
    expect((await agent.put(`/api/admin/config/workflow/${recordTypeId}/draft`, { definition: WORKFLOW })).status).toBe(403);
    expect((await agent.get(`/api/admin/config/layout/${recordTypeId}`)).status).toBe(403);
  });
});

describe("layouts", () => {
  it("defaults to every field, and a published layout sets sections and required fields", async () => {
    const before = await admin.get(`/api/admin/config/layout/${recordTypeId}`);
    expect(before.json.published).toBeNull();
    expect(before.json.effective.create.sections[0].fields).toEqual(["description", "priority", "vendor", "amount", "reason"]);

    const layout = {
      create: { sections: [{ title: "Invoice", fields: ["vendor", "amount", "description"] }] },
      view: { sections: [{ title: "Invoice", fields: ["vendor", "amount", "reason"] }, { title: "Routing", fields: ["assigneeId", "teamId"] }] },
      requiredOnCreate: ["amount"],
    };
    expect((await admin.put(`/api/admin/config/layout/${recordTypeId}/draft`, { definition: { ...layout, requiredOnCreate: ["reason"] } })).status).toBe(422);
    expect((await admin.put(`/api/admin/config/layout/${recordTypeId}/draft`, { definition: layout })).status).toBe(200);
    expect((await admin.post(`/api/admin/config/layout/${recordTypeId}/publish`, {})).status).toBe(200);

    const missing = await agent.post("/api/records", { recordTypeId, title: "x", custom: { vendor: "V" } });
    expect(missing.status).toBe(422);
    expect(missing.json.error.details.issues).toEqual([{ field: "custom.amount", message: "Required" }]);
  });

  it("requesters can set only the fields on the create form", async () => {
    const r = await requester.post("/api/records", { recordTypeId, title: "x", custom: { vendor: "V", amount: 5, reason: "qty" } });
    expect(r.status).toBe(422);
    expect(r.json.error.details.issues).toEqual([{ field: "custom.reason", message: "Unknown field" }]);
    const ok = await requester.post("/api/records", { recordTypeId, title: "x", priority: "urgent", custom: { vendor: "V", amount: 5 } });
    expect(ok.status).toBe(201);
    expect(ok.json.record.priority).toBe("medium"); // priority is not on this create form
    expect(ok.json.record.requesterId).toBe(requesterId);
  });

  it("the config endpoint carries workflow and layout for each record type", async () => {
    const config = await agent.get("/api/config");
    const rt = config.json.projects.find((p: any) => p.id === projectId).recordTypes[0];
    expect(rt.layout.requiredOnCreate).toEqual(["amount"]);
    expect(rt.workflow.statuses.length).toBeGreaterThan(0);
  });
});
