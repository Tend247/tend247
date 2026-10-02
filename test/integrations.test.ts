// Phase 3: webhook endpoints with a delivery log and redelivery, the dashboard, and CSV import.
import { describe, expect, it, beforeAll } from "vitest";
import { appSql, makeApp, createWorkspace, addUser, Client, setupApProject, type TestWorkspace } from "./helpers.ts";
import { runDueJobs } from "../src/worker/jobs/runner.ts";
import { signWebhook } from "../src/worker/jobs/webhooks.ts";
import { parseCsv } from "../src/worker/import/csv.ts";

const sql = appSql();
const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
let failNext = 0;
const { app, worker } = makeApp(sql, {
  webhookFetch: async (url, init) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
    if (failNext > 0) {
      failNext--;
      return new Response("nope", { status: 500 });
    }
    return new Response("ok");
  },
});

let ws: TestWorkspace;
let admin: Client;
let ap: { projectId: string; recordTypeId: string };

beforeAll(async () => {
  ws = await createWorkspace(sql);
  admin = await new Client(app).signIn(ws.admin.email, ws.slug);
  ap = await setupApProject(admin, "INT");
});

const bodies = (event: string) => calls.filter((c) => c.headers["x-tend-event"] === event).map((c) => JSON.parse(c.body));

describe("webhook endpoints", () => {
  let endpointId: string;

  it("validates endpoints and is admin-only", async () => {
    expect((await admin.post("/api/admin/webhooks", { name: "x", url: "https://localhost/hook", topics: ["record.created"] })).status).toBe(422);
    expect((await admin.post("/api/admin/webhooks", { name: "x", url: "https://hooks.example.com/a", topics: ["nope"] })).status).toBe(422);
    const agent = await addUser(sql, ws, "agent");
    const c = await new Client(app).signIn(agent.email, ws.slug);
    expect((await c.get("/api/admin/webhooks")).status).toBe(403);
  });

  it("delivers subscribed events, signed, with internal notes announced but never quoted", async () => {
    const created = await admin.post("/api/admin/webhooks", {
      name: "ERP",
      url: "https://hooks.example.com/erp",
      topics: ["record.created", "comment.created", "record.transitioned"],
    });
    expect(created.status).toBe(201);
    endpointId = created.json.endpoint.id;
    const secret = (await admin.get("/api/admin/webhook-secret")).json.secret;

    const r = await admin.post("/api/records", { recordTypeId: ap.recordTypeId, title: "Hooked", custom: { vendor: "Acme" } });
    await admin.post(`/api/records/${r.json.record.key}/comments`, { body: "secret margin note", internal: true });
    await admin.post(`/api/records/${r.json.record.key}/comments`, { body: "Hello vendor", internal: false });
    await admin.patch(`/api/records/${r.json.record.key}`, { version: 1, title: "Hooked (renamed)" }); // not subscribed
    await runDueJobs(worker());

    const createdEvents = bodies("record.created");
    expect(createdEvents.at(-1)!.record.key).toBe(r.json.record.key);
    const hook = calls.find((c) => c.headers["x-tend-event"] === "record.created")!;
    const ts = /t=(\d+)/.exec(hook.headers["x-tend-signature"]!)![1]!;
    expect(hook.headers["x-tend-signature"]).toBe(await signWebhook(secret, hook.body, Number(ts)));
    const comments = bodies("comment.created");
    expect(comments).toHaveLength(2);
    const internal = comments.find((b) => b.comment.internal)!;
    expect(internal.comment.body).toBeUndefined();
    expect(JSON.stringify(calls)).not.toContain("secret margin note");
    expect(comments.find((b) => !b.comment.internal)!.comment.body).toBe("Hello vendor");
    expect(bodies("record.updated")).toHaveLength(0);
  });

  it("respects the project filter", async () => {
    const other = await setupApProject(admin, "INX");
    await admin.patch(`/api/admin/webhooks/${endpointId}`, { projectId: ap.projectId });
    const before = bodies("record.created").length;
    await admin.post("/api/records", { recordTypeId: other.recordTypeId, title: "Elsewhere", custom: { vendor: "V" } });
    await admin.post("/api/records", { recordTypeId: ap.recordTypeId, title: "Here", custom: { vendor: "V" } });
    await runDueJobs(worker());
    const after = bodies("record.created").slice(before);
    expect(after.map((b) => b.record.title)).toEqual(["Here"]);
  });

  it("pings, logs failures, and redelivers", async () => {
    const ping = await admin.post(`/api/admin/webhooks/${endpointId}/ping`);
    expect(ping.status).toBe(201);
    expect(bodies("ping").length).toBeGreaterThan(0);

    failNext = 1;
    await admin.post("/api/records", { recordTypeId: ap.recordTypeId, title: "Will fail once", custom: { vendor: "V" } });
    await runDueJobs(worker());
    const log = await admin.get(`/api/admin/webhook-deliveries?endpointId=${endpointId}`);
    const failed = log.json.deliveries.find((d: { lastStatus: number | null }) => d.lastStatus === 500);
    expect(failed).toMatchObject({ status: "pending", attempts: 1, topic: "record.created" });
    const again = await admin.post(`/api/admin/webhook-deliveries/${failed.id}/redeliver`);
    expect(again.status).toBe(201);
    const log2 = await admin.get(`/api/admin/webhook-deliveries?endpointId=${endpointId}`);
    expect(log2.json.deliveries.find((d: { id: string }) => d.id === again.json.id).status).toBe("delivered");
    const list = await admin.get("/api/admin/webhooks");
    expect(list.json.endpoints[0].lastDelivery).not.toBeNull();
    expect((await admin.delete(`/api/admin/webhooks/${endpointId}`)).status).toBe(200);
  });
});

describe("dashboard", () => {
  it("counts what the viewer can see", async () => {
    const w2 = await createWorkspace(sql);
    const a2 = await new Client(app).signIn(w2.admin.email, w2.slug);
    const open = await setupApProject(a2, "OPN");
    const hidden = await setupApProject(a2, "HID");
    await a2.patch(`/api/admin/projects/${hidden.projectId}`, { restricted: true });
    for (const priority of ["low", "high", "urgent"]) {
      await a2.post("/api/records", { recordTypeId: open.recordTypeId, title: `Open ${priority}`, priority, custom: { vendor: "V" } });
    }
    await a2.post("/api/records", { recordTypeId: hidden.recordTypeId, title: "Private", custom: { vendor: "V" } });

    const d = await a2.get("/api/dashboard?days=14");
    expect(d.status).toBe(200);
    expect(d.json.totals.open).toBe(4);
    expect(d.json.openByPriority).toMatchObject({ low: 1, high: 1, urgent: 1, medium: 1 });
    expect(d.json.throughput).toHaveLength(14);
    expect(d.json.throughput.at(-1).created).toBe(4);
    expect(d.json.aging.reduce((n: number, b: { count: number }) => n + b.count, 0)).toBe(4);
    expect(d.json.sla.map((s: { metric: string }) => s.metric)).toEqual(["first_response", "resolution"]);

    const agent = await addUser(sql, w2, "agent");
    const ac = await new Client(app).signIn(agent.email, w2.slug);
    expect((await ac.get("/api/dashboard")).json.totals.open).toBe(3);
    expect((await ac.get(`/api/dashboard?projectId=${open.projectId}`)).json.openByProject).toHaveLength(1);
    const requester = await addUser(sql, w2, "requester");
    const rc = await new Client(app).signIn(requester.email, w2.slug);
    expect((await rc.get("/api/dashboard")).status).toBe(403);
  });
});

describe("CSV import", () => {
  it("parses quoted CSV", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\n"multi\nline",2\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["multi\nline", "2"],
    ]);
    expect(() => parseCsv('"open')).toThrow(/never closed/);
  });

  it("imports people with a dry run first", async () => {
    await admin.post("/api/admin/teams", { name: "AP team", memberIds: [] });
    const csv = `email,name,role,teams\nmorgan@co.test,Morgan,agent,AP team\nriley@co.test,Riley,requester,\n${ws.admin.email},Dup,admin,\nbad-email,X,agent,\nkim@co.test,Kim,wizard,\n`;
    const dry = await admin.post("/api/admin/import/users", { csv });
    expect(dry.json).toMatchObject({ dryRun: true, total: 5, created: 2, skipped: 1, errors: 2 });
    expect((await admin.get("/api/admin/users")).json.users.some((u: { email: string }) => u.email === "morgan@co.test")).toBe(false);
    const real = await admin.post("/api/admin/import/users", { csv, dryRun: false });
    expect(real.json).toMatchObject({ dryRun: false, created: 2, skipped: 1, errors: 2 });
    expect(real.json.rows.find((r: { line: number }) => r.line === 6).message).toMatch(/role/i);
    const teams = await admin.get("/api/admin/teams");
    expect(teams.json.teams.find((t: { name: string }) => t.name === "AP team").members.map((m: { email: string }) => m.email)).toEqual(["morgan@co.test"]);
  });

  it("imports records, matching fields by key or label, quietly by default", async () => {
    const agent = await addUser(sql, ws, "agent", "importee@co.test");
    const csv = [
      "Title,Description,Priority,Assignee,Vendor,Amount,Reason,Unknown column",
      'Invoice 1,First,high,importee@co.test,Acme,"$1,200.50",Quantity mismatch,x',
      "Invoice 2,,low,,Beta,99,price,",
      "Invoice 3,,medium,,Gamma,10,Not a reason,",
      ",No title,,,,,,",
      "Invoice 5,,,nobody@co.test,Delta,5,,",
    ].join("\n");
    const dry = await admin.post("/api/admin/import/records", { recordTypeId: ap.recordTypeId, csv });
    expect(dry.json).toMatchObject({ dryRun: true, total: 5, created: 2, errors: 3, unmatchedColumns: ["Unknown column"] });
    const before = (await admin.get("/api/records?limit=100")).json.items.length;
    expect((await admin.get("/api/records?limit=100")).json.items.length).toBe(before);

    const real = await admin.post("/api/admin/import/records", { recordTypeId: ap.recordTypeId, csv, dryRun: false });
    expect(real.json.created).toBe(2);
    const key = real.json.rows[0].key;
    const rec = (await admin.get(`/api/records/${key}`)).json.record;
    expect(rec).toMatchObject({ priority: "high", assigneeId: agent.id, via: "import", custom: { vendor: "Acme", amount: 1200.5, reason: "qty" } });
    expect(real.json.rows.find((r: { line: number }) => r.line === 4).message).toMatch(/not one of the choices/);
    // Quiet: the assignee was not notified about the bulk load.
    const ac = await new Client(app).signIn(agent.email, ws.slug);
    expect((await ac.get("/api/notifications")).json.notifications.filter((n: { recordId: string }) => n.recordId === rec.id)).toHaveLength(0);
  });
});
