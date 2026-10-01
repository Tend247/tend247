// Phase 2: approvals (any / sequential, in the app and by emailed link) and automation rules
// (conditions, actions, loop protection, signed webhooks with retries).
import { describe, expect, it, beforeAll } from "vitest";
import { runDueJobs } from "../src/worker/jobs/runner.ts";
import { signWebhook } from "../src/worker/jobs/webhooks.ts";
import { appSql, makeApp, createWorkspace, addUser, Client, setupApProject, type TestWorkspace } from "./helpers.ts";

const sql = appSql();
let clock = new Date();
const hooks: { url: string; headers: Record<string, string>; body: string }[] = [];
let hookStatus = 200;
const { app, email, worker } = makeApp(sql, {
  now: () => clock,
  webhookFetch: async (url, init) => {
    hooks.push({ url, headers: init.headers as Record<string, string>, body: init.body as string });
    return new Response("ok", { status: hookStatus });
  },
});

let ws: TestWorkspace;
let admin: Client;
let agent: Client;
let agentId: string;
let mgr: Client;
let mgrId: string;
let cfo: Client;
let cfoId: string;
let req: Client;
let reqEmail: string;
let recordTypeId: string;
let projectId: string;

beforeAll(async () => {
  ws = await createWorkspace(sql);
  admin = await new Client(app).signIn(ws.admin.email, ws.slug);
  const a = await addUser(sql, ws, "agent");
  const m = await addUser(sql, ws, "agent");
  const c = await addUser(sql, ws, "agent");
  const r = await addUser(sql, ws, "requester");
  [agentId, mgrId, cfoId, reqEmail] = [a.id, m.id, c.id, r.email];
  agent = await new Client(app).signIn(a.email, ws.slug);
  mgr = await new Client(app).signIn(m.email, ws.slug);
  cfo = await new Client(app).signIn(c.email, ws.slug);
  req = await new Client(app).signIn(r.email, ws.slug);
  ({ projectId, recordTypeId } = await setupApProject(admin, "APV"));
});

async function publishWorkflow(approval: { mode: "any" | "sequential"; approvers: string[] }) {
  const def = {
    initial: "new",
    statuses: [
      { key: "new", name: "New", category: "todo" },
      { key: "approved", name: "Approved", category: "in_progress" },
      { key: "paid", name: "Paid", category: "done" },
    ],
    transitions: [
      { key: "approve_payment", name: "Approve payment", from: ["new"], to: "approved", roles: ["admin", "agent", "requester"], approval },
      { key: "pay", name: "Pay", from: ["approved"], to: "paid" },
    ],
  };
  expect((await admin.put(`/api/admin/config/workflow/${recordTypeId}/draft`, { definition: def })).status).toBe(200);
  const p = await admin.post(`/api/admin/config/workflow/${recordTypeId}/publish`, { statusMap: { in_progress: "approved", waiting: "approved", done: "paid" } });
  expect(p.status).toBe(200);
}

const newRecord = async (client: Client = agent, extra: Record<string, unknown> = {}) =>
  (await client.post("/api/records", { recordTypeId, title: "Pay Acme $12,400", custom: { vendor: "Acme", amount: 12400 }, ...extra })).json.record;

describe("approvals", () => {
  it("only active staff can be approvers", async () => {
    const bad = await admin.put(`/api/admin/config/workflow/${recordTypeId}/draft`, {
      definition: { initial: "new", statuses: [{ key: "new", name: "New", category: "todo" }, { key: "ok", name: "OK", category: "done" }], transitions: [{ key: "go", name: "Go", from: ["new"], to: "ok", approval: { mode: "any", approvers: [(await addUser(sql, ws, "requester")).id] } }] },
    });
    expect(bad.status).toBe(422);
    expect(bad.json.error.details.issues[0].field).toBe("transitions.0.approval.approvers.0");
  });

  it("opens an approval instead of moving the record, and blocks other moves meanwhile", async () => {
    await publishWorkflow({ mode: "any", approvers: [mgrId, cfoId] });
    const rec = await newRecord(req);
    const r = await req.post(`/api/records/${rec.key}/transitions`, { transition: "approve_payment" });
    expect(r.status).toBe(200);
    expect(r.json.record.status).toBe("new");
    expect(r.json.record.pendingApprovalId).toBe(r.json.approval.id);
    expect(r.json.approval).toMatchObject({ status: "pending", mode: "any", steps: [{ approvers: [mgrId, cfoId] }] });
    expect((await agent.post(`/api/records/${rec.key}/transitions`, { transition: "approve_payment" })).status).toBe(409);
    expect((await agent.get(`/api/records/${rec.key}`)).json.transitions).toEqual([]);

    // Approvers are notified in the app and by email with a one-time link.
    const mine = await mgr.get("/api/approvals");
    expect(mine.json.approvals.map((a: { recordKey: string }) => a.recordKey)).toContain(rec.key);
    const mail = email.sent.filter((m) => m.text.includes("/auth/approval#") && m.subject.includes(rec.key));
    expect(mail).toHaveLength(2);

    // Not an approver; then an approver approves and the record moves.
    expect((await agent.post(`/api/approvals/${r.json.approval.id}/decision`, { decision: "approve" })).status).toBe(403);
    const ok = await mgr.post(`/api/approvals/${r.json.approval.id}/decision`, { decision: "approve", comment: "Matches PO 5512" });
    expect(ok.status).toBe(200);
    expect(ok.json.approval.status).toBe("approved");
    const after = (await agent.get(`/api/records/${rec.key}`)).json;
    expect(after.record).toMatchObject({ status: "approved", pendingApprovalId: null });
    // The requester learns the outcome but not who the approvers were.
    expect(after.approvals[0].steps[0].approvers).toEqual([mgrId, cfoId]);
    const forReq = (await req.get(`/api/records/${rec.key}`)).json.approvals[0];
    expect(forReq.steps[0]).toEqual({ decision: "approved", approvers: [] });
    expect((await req.get("/api/notifications")).json.notifications.some((n: { kind: string }) => n.kind === "approval_result")).toBe(true);
  });

  it("never lets someone approve their own request", async () => {
    const rec = await newRecord(mgr);
    const r = await mgr.post(`/api/records/${rec.key}/transitions`, { transition: "approve_payment" });
    expect(r.json.approval.steps[0].approvers).toEqual([cfoId]); // the requester is left out
    expect((await mgr.post(`/api/approvals/${r.json.approval.id}/decision`, { decision: "approve" })).status).toBe(403);
  });

  it("runs sequential approvals in order and stops at a rejection", async () => {
    await publishWorkflow({ mode: "sequential", approvers: [mgrId, cfoId] });
    const rec = await newRecord(req);
    const { approval } = (await req.post(`/api/records/${rec.key}/transitions`, { transition: "approve_payment" })).json;
    expect(approval.steps).toHaveLength(2);
    expect((await cfo.post(`/api/approvals/${approval.id}/decision`, { decision: "approve" })).status).toBe(403); // not yet
    const first = await mgr.post(`/api/approvals/${approval.id}/decision`, { decision: "approve" });
    expect(first.json.approval).toMatchObject({ status: "pending", currentStep: 1 });
    const second = await cfo.post(`/api/approvals/${approval.id}/decision`, { decision: "reject" });
    expect(second.json.approval.status).toBe("rejected");
    expect((await agent.get(`/api/records/${rec.key}`)).json.record).toMatchObject({ status: "new", pendingApprovalId: null });
  });

  it("decides from an emailed link once, without signing in", async () => {
    await publishWorkflow({ mode: "any", approvers: [cfoId] });
    const rec = await newRecord(req);
    await req.post(`/api/records/${rec.key}/transitions`, { transition: "approve_payment" });
    const mail = email.sent.filter((m) => m.subject.includes(rec.key) && m.text.includes("/auth/approval#")).at(-1)!;
    const token = /\/auth\/approval#(\S+)/.exec(mail.text)![1]!;
    const anon = new Client(app);
    expect((await anon.get("/auth/approval")).status).toBe(200);
    const peek = await anon.post("/auth/approval/peek", { token });
    expect(peek.json).toMatchObject({ record: { key: rec.key }, transitionName: "Approve payment", status: "pending" });
    const tampered = token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA");
    expect((await anon.post("/auth/approval/decide", { token: tampered, decision: "approve" })).status).toBe(404);
    const d = await anon.post("/auth/approval/decide", { token, decision: "approve" });
    expect(d.status).toBe(200);
    expect(d.json.status).toBe("approved");
    expect((await anon.post("/auth/approval/decide", { token, decision: "reject" })).status).toBe(404);
    expect((await agent.get(`/api/records/${rec.key}`)).json.record.status).toBe("approved");
  });

  it("can be withdrawn by the requester", async () => {
    const rec = await newRecord(req);
    const { approval } = (await req.post(`/api/records/${rec.key}/transitions`, { transition: "approve_payment" })).json;
    expect((await agent.post(`/api/approvals/${approval.id}/cancel`)).status).toBe(403);
    expect((await req.post(`/api/approvals/${approval.id}/cancel`)).json.approval.status).toBe("cancelled");
  });
});

describe("automation", () => {
  it("validates rules (https webhooks on public hosts, known record types)", async () => {
    const bad = await admin.post("/api/admin/automation", {
      name: "bad",
      trigger: "record.created",
      actions: [{ type: "webhook", url: "http://10.0.0.5/hook" }, { type: "create_linked", recordTypeId: "00000000-0000-4000-8000-000000000000", title: "x" }],
    });
    expect(bad.status).toBe(422);
    expect(bad.json.error.details.issues.map((i: { field: string }) => i.field)).toEqual(["actions.0.url", "actions.1.recordTypeId"]);
    expect((await agent.post("/api/admin/automation", { name: "x", trigger: "record.created", actions: [] })).status).toBe(403);
  });

  it("runs matching rules after a change: assign, comment, webhook", async () => {
    const rule = await admin.post("/api/admin/automation", {
      name: "Urgent payments to Ann",
      projectId,
      trigger: "record.created",
      conditions: [{ field: "priority", op: "eq", value: "urgent" }, { field: "custom.amount", op: "not_empty" }],
      actions: [
        { type: "assign", userId: agentId },
        { type: "comment", body: "Auto-routed {{key}} to the urgent desk", internal: true },
        { type: "webhook", url: "https://hooks.example.com/tend" },
      ],
    });
    expect(rule.status).toBe(201);
    const plain = await newRecord(req);
    expect((await agent.get(`/api/records/${plain.key}`)).json.record.assigneeId).toBeNull();

    const urgent = await newRecord(admin, { priority: "urgent" });
    const detail = await agent.get(`/api/records/${urgent.key}`);
    expect(detail.json.record.assigneeId).toBe(agentId);
    const comments = (await agent.get(`/api/records/${urgent.key}/comments`)).json.comments;
    expect(comments[0]).toMatchObject({ body: `Auto-routed ${urgent.key} to the urgent desk`, internal: true, authorId: null, via: "automation" });
    const events = (await agent.get(`/api/records/${urgent.key}/events`)).json.events.map((e: { kind: string }) => e.kind);
    expect(events).toContain("automation_ran");

    clock = new Date(Date.now() + 1000);
    await runDueJobs(worker());
    const hook = hooks.find((h) => h.body.includes(urgent.key))!;
    expect(hook.url).toBe("https://hooks.example.com/tend");
    expect(hook.headers["x-tend-event"]).toBe("record.created");
    const secret = (await admin.get("/api/admin/webhook-secret")).json.secret;
    const ts = /t=(\d+)/.exec(hook.headers["x-tend-signature"]!)![1]!;
    expect(hook.headers["x-tend-signature"]).toBe(await signWebhook(secret, hook.body, Number(ts)));
    await admin.patch(`/api/admin/automation/${rule.json.rule.id}`, { enabled: false });
  });

  it("retries failed webhooks with backoff and gives up after six attempts", async () => {
    const rule = await admin.post("/api/admin/automation", {
      name: "Hook on resolve",
      trigger: "record.transitioned",
      conditions: [{ field: "event.to", op: "eq", value: "paid" }],
      actions: [{ type: "webhook", url: "https://hooks.example.com/paid" }],
    });
    hookStatus = 500;
    clock = new Date();
    const rec = await newRecord(admin);
    await admin.post(`/api/records/${rec.key}/transitions`, { transition: "approve_payment" }).then(async (r) => {
      await cfo.post(`/api/approvals/${r.json.approval.id}/decision`, { decision: "approve" });
    });
    await admin.post(`/api/records/${rec.key}/transitions`, { transition: "pay" });
    for (let i = 0; i < 8; i++) {
      await runDueJobs(worker());
      clock = new Date(clock.getTime() + 13 * 3600_000);
    }
    const deliveries = (await admin.get("/api/admin/webhook-deliveries")).json.deliveries.filter((d: { url: string }) => d.url.endsWith("/paid"));
    expect(deliveries[0]).toMatchObject({ status: "failed", attempts: 6, lastStatus: 500 });
    hookStatus = 200;
    await admin.delete(`/api/admin/automation/${rule.json.rule.id}`);
  });

  it("never loops: a rule does not re-trigger itself and chains stop at depth 3", async () => {
    // Rule A: on update, bump priority between high and urgent (would loop forever).
    await admin.post("/api/admin/automation", {
      name: "Ping-pong",
      trigger: "record.updated",
      conditions: [{ field: "title", op: "contains", value: "loop" }],
      actions: [{ type: "set_field", field: "priority", value: "urgent" }],
    });
    await admin.post("/api/admin/automation", {
      name: "Pong-ping",
      trigger: "record.updated",
      conditions: [{ field: "title", op: "contains", value: "loop" }, { field: "priority", op: "eq", value: "urgent" }],
      actions: [{ type: "set_field", field: "priority", value: "high" }],
    });
    const rec = await newRecord(agent, { title: "loop test" });
    const r = await agent.patch(`/api/records/${rec.key}`, { version: rec.version, description: "go" });
    expect(r.status).toBe(200);
    const events = (await agent.get(`/api/records/${rec.key}/events`)).json.events.filter((e: { kind: string }) => e.kind === "automation_ran");
    expect(events.length).toBeLessThanOrEqual(3);
    expect(events.length).toBeGreaterThan(0);
  });

  it("creates linked records and notifies people", async () => {
    await admin.post("/api/admin/automation", {
      name: "Follow-up task",
      trigger: "comment.created",
      conditions: [{ field: "event.internal", op: "eq", value: false }, { field: "via", op: "eq", value: "app" }],
      actions: [
        { type: "create_linked", recordTypeId, title: "Follow up on {{key}}", linkKind: "relates" },
        { type: "notify", to: ["requester", mgrId], message: "{{key}} has a new reply" },
      ],
    });
    const rec = await newRecord(req, { title: "Need W-9" });
    await agent.post(`/api/records/${rec.key}/comments`, { body: "Sent the form" });
    const links = (await agent.get(`/api/records/${rec.key}`)).json.links;
    expect(links[0].other.title).toBe(`Follow up on ${rec.key}`);
    const n = (await mgr.get("/api/notifications")).json.notifications;
    expect(n.some((x: { kind: string; title: string }) => x.kind === "automation" && x.title === `${rec.key}: ${rec.key} has a new reply`)).toBe(true);
    expect(email.sent.some((m) => m.to === reqEmail && m.text.includes("has a new reply"))).toBe(true);
  });
});
