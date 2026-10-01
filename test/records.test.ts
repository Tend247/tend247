import { beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../src/worker/db/client.ts";
import { createRecord, listRecords } from "../src/worker/records/service.ts";
import { appSql, makeApp, createWorkspace, addUser, Client, setupApProject, type TestWorkspace } from "./helpers.ts";

const sql = appSql();
const { app } = makeApp(sql);

let ws: TestWorkspace;
let admin: Client;
let agent: Client;
let requester: Client;
let requesterId: string;
let recordTypeId: string;

beforeAll(async () => {
  ws = await createWorkspace(sql);
  admin = await new Client(app).signIn(ws.admin.email, ws.slug);
  const ag = await addUser(sql, ws, "agent");
  agent = await new Client(app).signIn(ag.email, ws.slug);
  const rq = await addUser(sql, ws, "requester");
  requesterId = rq.id;
  requester = await new Client(app).signIn(rq.email, ws.slug);
  ({ recordTypeId } = await setupApProject(admin));
});

describe("records", () => {
  it("numbers records per project", async () => {
    const r1 = await agent.post("/api/records", { recordTypeId, title: "Chili supplier invoice", custom: { vendor: "Ancho & Co" } });
    const r2 = await agent.post("/api/records", { recordTypeId, title: "Jar lids short", custom: { vendor: "LidCo" } });
    expect([r1.status, r2.status]).toEqual([201, 201]);
    expect([r1.json.record.key, r2.json.record.key]).toEqual(["FIN-1", "FIN-2"]);
    expect(r1.json.record.custom).toEqual({ vendor: "Ancho & Co", reason: "price" });
  });

  it("validates custom fields", async () => {
    const r = await agent.post("/api/records", { recordTypeId, title: "x", custom: { amount: "abc" } });
    expect(r.status).toBe(422);
    const fields = r.json.error.details.issues.map((i: { field: string }) => i.field).sort();
    expect(fields).toEqual(["custom.amount", "custom.vendor"]);
  });

  it("finds a record by key and records its history", async () => {
    const created = await agent.post("/api/records", { recordTypeId, title: "Freight overcharge", custom: { vendor: "Haul" } });
    const key = created.json.record.key;
    const got = await agent.get(`/api/records/${key.toLowerCase()}`);
    expect(got.json.record.id).toBe(created.json.record.id);

    const upd = await agent.patch(`/api/records/${key}`, { version: 1, priority: "high", custom: { amount: 120.5 } });
    expect(upd.status).toBe(200);
    expect(upd.json.record.version).toBe(2);
    const events = await agent.get(`/api/records/${key}/events`);
    expect(events.json.events.map((e: { kind: string }) => e.kind)).toEqual(["created", "updated"]);
    expect(events.json.events[1].data.changes).toEqual([
      { field: "priority", from: "medium", to: "high" },
      { field: "custom.amount", from: null, to: 120.5 },
    ]);
    const outbox = await withTenant(sql, ws.id, (tx) =>
      tx<{ topic: string }[]>`select topic from outbox where payload->>'key' = ${key} order by id`,
    );
    expect(outbox.map((o) => o.topic)).toEqual(["record.created", "record.updated"]);
  });

  it("rejects a stale version with 409", async () => {
    const created = await agent.post("/api/records", { recordTypeId, title: "Two editors", custom: { vendor: "V" } });
    const id = created.json.record.id;
    expect((await agent.patch(`/api/records/${id}`, { version: 1, title: "First" })).status).toBe(200);
    const stale = await admin.patch(`/api/records/${id}`, { version: 1, title: "Second" });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe("version_conflict");
  });

  it("moves deleted records to the trash, where only admins restore them", async () => {
    const created = await agent.post("/api/records", { recordTypeId, title: "Duplicate", custom: { vendor: "V" } });
    const id = created.json.record.id;
    expect((await agent.delete(`/api/records/${id}`)).status).toBe(200);
    expect((await agent.get(`/api/records/${id}`)).status).toBe(404);
    expect((await agent.get("/api/trash")).status).toBe(403);
    const trash = await admin.get("/api/trash");
    expect(trash.json.records.map((r: { id: string }) => r.id)).toContain(id);
    expect((await agent.post(`/api/records/${id}/restore`)).status).toBe(403);
    expect((await admin.post(`/api/records/${id}/restore`)).status).toBe(200);
    expect((await agent.get(`/api/records/${id}`)).status).toBe(200);
    const events = await admin.get(`/api/records/${id}/events`);
    expect(events.json.events.map((e: { kind: string }) => e.kind)).toEqual(["created", "deleted", "restored"]);
  });

  it("lets requesters file and read only their own requests", async () => {
    const mine = await requester.post("/api/records", {
      recordTypeId,
      title: "Where is my reimbursement?",
      assigneeId: ws.admin.id,
      custom: { vendor: "Me" },
    });
    expect(mine.status).toBe(201);
    expect(mine.json.record.requesterId).toBe(requesterId);
    expect(mine.json.record.assigneeId).toBeNull();
    const list = await requester.get("/api/records");
    expect(list.json.items.map((r: { id: string }) => r.id)).toEqual([mine.json.record.id]);
    expect((await requester.patch(`/api/records/${mine.json.record.id}`, { version: 1, title: "x" })).status).toBe(403);
    expect((await requester.delete(`/api/records/${mine.json.record.id}`)).status).toBe(403);
  });

  it("filters by assignee and searches text", async () => {
    const r = await agent.post("/api/records", {
      recordTypeId,
      title: "Spice blend invoice dispute",
      assigneeId: ws.admin.id,
      custom: { vendor: "Saffron Ltd" },
    });
    const byAssignee = await admin.get("/api/records?assigneeId=me");
    expect(byAssignee.json.items.map((x: { id: string }) => x.id)).toContain(r.json.record.id);
    const search = await admin.get("/api/records?q=spice");
    expect(search.json.items.map((x: { id: string }) => x.id)).toEqual([r.json.record.id]);
  });

  it("paginates with a cursor", async () => {
    const first = await admin.get("/api/records?limit=2");
    expect(first.json.items).toHaveLength(2);
    expect(first.json.nextCursor).toBeTruthy();
    const second = await admin.get(`/api/records?limit=2&cursor=${first.json.nextCursor}`);
    const ids = new Set([...first.json.items, ...second.json.items].map((x: { id: string }) => x.id));
    expect(ids.size).toBe(4);
  });

  it("pages through records created in the same instant without skipping any", async () => {
    const actor = { tenantId: ws.id, userId: ws.admin.id, role: "admin" as const };
    const ids = await withTenant(sql, ws.id, async (tx) => {
      const out: string[] = [];
      for (let i = 0; i < 3; i++) {
        out.push((await createRecord(tx, actor, { recordTypeId, title: `Bulk ${i}`, custom: { vendor: "Bulk" } })).id);
      }
      return out;
    });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await withTenant(sql, ws.id, (tx) => listRecords(tx, actor, { custom: { vendor: "Bulk" }, limit: 1, cursor }));
      seen.push(...page.items.map((r) => r.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen.sort()).toEqual([...ids].sort());
  });

  it("accepts person ids in any letter case", async () => {
    const r = await agent.post("/api/records", {
      recordTypeId,
      title: "Uppercase id",
      assigneeId: ws.admin.id.toUpperCase(),
      custom: { vendor: "V" },
    });
    expect(r.status).toBe(201);
    expect(r.json.record.assigneeId).toBe(ws.admin.id);
  });

  it("refuses removing a choice that records still use", async () => {
    const fields = await admin.get(`/api/admin/record-types/${recordTypeId}/fields`);
    const reason = fields.json.fields.find((f: { key: string }) => f.key === "reason");
    const r = await admin.patch(`/api/admin/fields/${reason.id}`, {
      options: { choices: [{ value: "qty", label: "Quantity mismatch" }] },
    });
    expect(r.status).toBe(422);
  });

  it("returns 400 for malformed ids", async () => {
    expect((await admin.patch("/api/admin/fields/not-a-uuid", { label: "x" })).status).toBe(400);
  });
});
