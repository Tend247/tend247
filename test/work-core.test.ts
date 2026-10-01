// Phase 1: teams and round-robin, restricted projects, comments, watchers, attachments,
// views, links, bulk edit, board, search, trash and revert.
import { describe, expect, it, beforeAll } from "vitest";
import { withTenant } from "../src/worker/db/client.ts";
import { MemoryBlobStore } from "../src/worker/attachments/blobs.ts";
import { purgeTrash } from "../src/worker/jobs/runner.ts";
import { appSql, makeApp, createWorkspace, addUser, Client, setupApProject, type TestWorkspace } from "./helpers.ts";

const sql = appSql();
const blobs = new MemoryBlobStore();
const replica = new MemoryBlobStore();
const { app, worker } = makeApp(sql, { blobs, replica });

let ws: TestWorkspace;
let admin: Client;
let ann: Client; // agent on the AP team
let bob: Client; // agent on the AP team
let cal: Client; // agent, not on the team
let req: Client;
let annId: string;
let bobId: string;
let calId: string;
let reqId: string;
let teamId: string;
let projectId: string;
let recordTypeId: string;

beforeAll(async () => {
  ws = await createWorkspace(sql);
  admin = await new Client(app).signIn(ws.admin.email, ws.slug);
  const a = await withTenant(sql, ws.id, (tx) => tx`insert into users (tenant_id, email, display_name, role) values (${ws.id}, ${"ann@" + ws.slug + ".test"}, 'Ann', 'agent') returning id, email`);
  const b = await withTenant(sql, ws.id, (tx) => tx`insert into users (tenant_id, email, display_name, role) values (${ws.id}, ${"bob@" + ws.slug + ".test"}, 'Bob', 'agent') returning id, email`);
  const c = await addUser(sql, ws, "agent");
  const r = await addUser(sql, ws, "requester");
  annId = a[0]!.id as string;
  bobId = b[0]!.id as string;
  calId = c.id;
  reqId = r.id;
  ann = await new Client(app).signIn(a[0]!.email as string, ws.slug);
  bob = await new Client(app).signIn(b[0]!.email as string, ws.slug);
  cal = await new Client(app).signIn(c.email, ws.slug);
  req = await new Client(app).signIn(r.email, ws.slug);
  ({ projectId, recordTypeId } = await setupApProject(admin, "AP"));
  const team = await admin.post("/api/admin/teams", { name: "AP team", memberIds: [annId, bobId] });
  expect(team.status).toBe(201);
  teamId = team.json.team.id;
});

const create = (client: Client, extra: Record<string, unknown> = {}) =>
  client.post("/api/records", { recordTypeId, title: "Invoice mismatch", custom: { vendor: "Acme" }, ...extra });

describe("teams and assignment", () => {
  it("routes new records to the project's team, round-robin", async () => {
    const p = await admin.patch(`/api/admin/projects/${projectId}`, { defaultTeamId: teamId, assignment: "round_robin" });
    expect(p.status).toBe(200);
    expect(p.json.project).toMatchObject({ defaultTeamId: teamId, assignment: "round_robin" });
    const assignees = [];
    for (let i = 0; i < 4; i++) {
      const r = await create(req);
      expect(r.json.record.teamId).toBe(teamId);
      assignees.push(r.json.record.assigneeName);
    }
    expect(assignees).toEqual(["Ann", "Bob", "Ann", "Bob"]);
  });

  it("only staff can be team members; teams are audited", async () => {
    const bad = await admin.patch(`/api/admin/teams/${teamId}`, { memberIds: [annId, reqId] });
    expect(bad.status).toBe(422);
    const audit = await admin.get("/api/admin/audit?limit=3");
    expect(audit.json.entries.some((e: { entity: string }) => e.entity === "team")).toBe(true);
  });

  it("filters by team and assignee", async () => {
    const mine = await ann.get("/api/records?teamId=mine&assigneeId=me");
    expect(mine.json.items.length).toBe(2);
    expect(mine.json.items.every((r: { assigneeId: string }) => r.assigneeId === annId)).toBe(true);
  });
});

describe("restricted projects", () => {
  it("hides a restricted project's records from agents outside its teams", async () => {
    const rec = (await create(ann)).json.record;
    expect((await cal.get(`/api/records/${rec.key}`)).status).toBe(200);
    await admin.patch(`/api/admin/projects/${projectId}`, { restricted: true });
    expect((await cal.get(`/api/records/${rec.key}`)).status).toBe(404);
    expect((await cal.get(`/api/records?projectId=${projectId}`)).json.items).toEqual([]);
    expect((await bob.get(`/api/records/${rec.key}`)).status).toBe(200); // team member
    // Assigning Cal lets Cal see that one record.
    await admin.patch(`/api/records/${rec.key}`, { version: rec.version, assigneeId: calId });
    expect((await cal.get(`/api/records/${rec.key}`)).status).toBe(200);
    // Mentions cannot pull in people who cannot see the record.
    const other = (await create(ann)).json.record;
    const m = await ann.post(`/api/records/${other.key}/comments`, { body: "@Cal please look", mentions: [calId] });
    expect(m.status).toBe(422);
    await admin.patch(`/api/admin/projects/${projectId}`, { restricted: false });
  });
});

describe("comments and watchers", () => {
  it("keeps internal notes from requesters and records the first response", async () => {
    const rec = (await create(req)).json.record;
    expect((await req.post(`/api/records/${rec.key}/comments`, { body: "secret", internal: true })).status).toBe(403);
    expect((await ann.post(`/api/records/${rec.key}/comments`, { body: "Checking with AP lead", internal: true })).status).toBe(201);
    let detail = await ann.get(`/api/records/${rec.key}`);
    expect(detail.json.record.firstRespondedAt).toBeNull(); // internal notes are not a response
    expect((await ann.post(`/api/records/${rec.key}/comments`, { body: "Looking into it", mentions: [bobId] })).status).toBe(201);
    detail = await ann.get(`/api/records/${rec.key}`);
    expect(detail.json.record.firstRespondedAt).not.toBeNull();

    const seen = await req.get(`/api/records/${rec.key}/comments`);
    expect(seen.json.comments.map((c: { body: string }) => c.body)).toEqual(["Looking into it"]);
    const staff = await bob.get(`/api/records/${rec.key}/comments`);
    expect(staff.json.comments).toHaveLength(2);
    const watchers = await bob.get(`/api/records/${rec.key}/watchers`);
    expect(watchers.json.watchers.map((w: { displayName: string }) => w.displayName).sort()).toEqual(["Ann", "Bob"]);
  });

  it("notifies mentions and watchers in the app", async () => {
    const n = await bob.get("/api/notifications");
    expect(n.json.notifications.some((x: { kind: string }) => x.kind === "mention")).toBe(true);
    expect(n.json.unread).toBeGreaterThan(0);
    await bob.post("/api/notifications/read", { all: true });
    expect((await bob.get("/api/notifications")).json.unread).toBe(0);
  });

  it("lets authors edit, and authors or admins delete and admins restore", async () => {
    const rec = (await create(req)).json.record;
    const c = (await ann.post(`/api/records/${rec.key}/comments`, { body: "first" })).json.comment;
    expect((await bob.patch(`/api/comments/${c.id}`, { body: "hijack" })).status).toBe(403);
    expect((await ann.patch(`/api/comments/${c.id}`, { body: "edited" })).json.comment.editedAt).not.toBeNull();
    expect((await bob.delete(`/api/comments/${c.id}`)).status).toBe(403);
    expect((await ann.delete(`/api/comments/${c.id}`)).status).toBe(200);
    expect((await req.get(`/api/records/${rec.key}/comments`)).json.comments).toEqual([]);
    const trash = await admin.get("/api/trash");
    expect(trash.json.comments.some((x: { id: string }) => x.id === c.id)).toBe(true);
    expect((await admin.post(`/api/comments/${c.id}/restore`)).status).toBe(200);
  });

  it("watching can be toggled; requesters only for themselves", async () => {
    const rec = (await create(req)).json.record;
    expect((await req.post(`/api/records/${rec.key}/watchers`, { watching: true, userId: annId })).status).toBe(403);
    expect((await cal.post(`/api/records/${rec.key}/watchers`, { watching: true })).status).toBe(200);
    expect((await cal.get(`/api/records/${rec.key}`)).json.watching).toBe(true);
    expect((await cal.post(`/api/records/${rec.key}/watchers`, { watching: false })).status).toBe(200);
    expect((await cal.get(`/api/records/${rec.key}`)).json.watching).toBe(false);
  });
});

describe("attachments", () => {
  let recKey: string;
  beforeAll(async () => {
    recKey = (await create(req)).json.record.key;
  });

  it("uploads into storage and downloads with safe headers", async () => {
    const up = await req.upload(`/api/records/${recKey}/attachments`, new TextEncoder().encode("<script>alert(1)</script>"), "notes/../evil.html", "text/html");
    expect(up.status).toBe(201);
    expect(up.json.attachment).toMatchObject({ filename: "notes_.._evil.html", sizeBytes: 25, contentType: "text/html" });
    expect(up.json.attachment.storageKey).toBeUndefined();
    const res = await ann.raw(`/api/attachments/${up.json.attachment.id}?inline=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename\*=UTF-8''/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("<script>alert(1)</script>");

    const png = await ann.upload(`/api/records/${recKey}/attachments`, new Uint8Array([137, 80, 78, 71]), "shot.png", "image/png");
    const inline = await ann.raw(`/api/attachments/${png.json.attachment.id}?inline=1`);
    expect(inline.headers.get("content-type")).toBe("image/png");
    expect(inline.headers.get("content-disposition")).toMatch(/^inline/);
  });

  it("requires the upload header (CSRF) and respects the size limit", async () => {
    const res = await app.request(`http://localhost/api/records/${recKey}/attachments`, {
      method: "POST",
      body: "x",
      headers: { "content-type": "text/plain", cookie: req.cookie },
    });
    expect(res.status).toBe(415);
    await admin.patch("/api/admin/settings", { attachmentMaxMb: 1 });
    const big = await req.upload(`/api/records/${recKey}/attachments`, new Uint8Array(1024 * 1024 + 1), "big.bin");
    expect(big.status).toBe(400);
    await admin.patch("/api/admin/settings", { attachmentMaxMb: 25 });
  });

  it("hides attachments on internal notes from requesters", async () => {
    const note = (await ann.post(`/api/records/${recKey}/comments`, { body: "internal evidence", internal: true })).json.comment;
    const up = await ann.upload(`/api/records/${recKey}/attachments?commentId=${note.id}`, new Uint8Array([1, 2, 3]), "ledger.csv", "text/csv");
    expect(up.status).toBe(201);
    expect((await req.raw(`/api/attachments/${up.json.attachment.id}`)).status).toBe(404);
    const list = await req.get(`/api/records/${recKey}/attachments`);
    expect(list.json.attachments.some((a: { id: string }) => a.id === up.json.attachment.id)).toBe(false);
    expect((await cal.get(`/api/records/${recKey}/attachments`)).json.attachments.length).toBe(3);
  });

  it("other workspaces and other requesters cannot reach a file", async () => {
    const list = await ann.get(`/api/records/${recKey}/attachments`);
    const id = list.json.attachments[0].id;
    const other = await addUser(sql, ws, "requester");
    const stranger = await new Client(app).signIn(other.email, ws.slug);
    expect((await stranger.raw(`/api/attachments/${id}`)).status).toBe(404);
    const ws2 = await createWorkspace(sql);
    const admin2 = await new Client(app).signIn(ws2.admin.email, ws2.slug);
    expect((await admin2.raw(`/api/attachments/${id}`)).status).toBe(404);
  });

  it("replicates uploads to the replica bucket", async () => {
    const up = await ann.upload(`/api/records/${recKey}/attachments`, new Uint8Array([9, 9, 9]), "copy.bin");
    const { runDueJobs } = await import("../src/worker/jobs/runner.ts");
    await runDueJobs(worker());
    const [row] = await withTenant(sql, ws.id, (tx) => tx`select storage_key, replicated_at from attachments where id = ${up.json.attachment.id}`);
    expect(row!.replicatedAt).not.toBeNull();
    expect(replica.objects.has(row!.storageKey as string)).toBe(true);
  });
});

describe("views, links, bulk edit, board, search", () => {
  it("saves personal and shared views", async () => {
    const v = await ann.post("/api/views", { name: "My urgent", definition: { filters: { priority: ["urgent"], assigneeId: "me" }, sort: "priority_desc" } });
    expect(v.status).toBe(201);
    const shared = await ann.post("/api/views", { name: "AP open", shared: true, definition: { filters: { projectId, statusCategory: ["todo", "in_progress"] }, mode: "board" } });
    expect(shared.status).toBe(201);
    expect((await bob.get("/api/views")).json.views.map((x: { name: string }) => x.name)).toEqual(["AP open"]);
    expect((await bob.patch(`/api/views/${shared.json.view.id}`, { name: "x" })).status).toBe(403);
    expect((await admin.patch(`/api/views/${shared.json.view.id}`, { name: "AP open work" })).status).toBe(200);
    expect((await req.post("/api/views", { name: "x", shared: true, definition: {} })).status).toBe(403);
    expect((await bob.delete(`/api/views/${v.json.view.id}`)).status).toBe(404);
  });

  it("links records without revealing ones the viewer cannot see", async () => {
    const a = (await create(ann)).json.record;
    const b = (await create(ann)).json.record;
    const l = await ann.post(`/api/records/${a.key}/links`, { to: b.key, kind: "blocks" });
    expect(l.status).toBe(201);
    const detail = await bob.get(`/api/records/${b.key}`);
    expect(detail.json.links).toEqual([expect.objectContaining({ kind: "blocks", direction: "inward", other: expect.objectContaining({ key: a.key }) })]);
    expect((await ann.post(`/api/records/${a.key}/links`, { to: a.key, kind: "relates" })).status).toBe(400);
    expect((await req.post(`/api/records/${a.key}/links`, { to: b.key, kind: "relates" })).status).toBe(403);
    expect((await ann.delete(`/api/links/${l.json.link.id}`)).status).toBe(200);
  });

  it("bulk edits many records, reporting failures per record", async () => {
    const recs = [(await create(ann)).json.record, (await create(ann)).json.record];
    const r = await ann.post("/api/records/bulk", { ids: [...recs.map((x) => x.key), "AP-99999"], patch: { priority: "high" }, transition: "start" });
    expect(r.status).toBe(200);
    expect(r.json.updated).toBe(2);
    expect(r.json.results.at(-1)).toMatchObject({ ok: false, error: "Record not found" });
    const again = await ann.post("/api/records/bulk", { ids: [recs[0].key], transition: "start" });
    expect(again.json.results[0]).toMatchObject({ ok: false });
    expect((await ann.get(`/api/records/${recs[1].key}`)).json.record).toMatchObject({ priority: "high", status: "in_progress" });
    expect((await req.post("/api/records/bulk", { ids: [recs[0].key], patch: { priority: "low" } })).status).toBe(403);
  });

  it("groups records into board columns by workflow status", async () => {
    const board = await ann.get(`/api/board?recordTypeId=${recordTypeId}`);
    expect(board.status).toBe(200);
    expect(board.json.columns.map((c: { key: string }) => c.key)).toEqual(["new", "in_progress", "waiting", "done"]);
    const total = board.json.columns.reduce((n: number, c: { total: number }) => n + c.total, 0);
    expect(total).toBeGreaterThan(5);
    const cats = await ann.get("/api/board");
    expect(cats.json.columns.map((c: { key: string }) => c.key)).toEqual(["todo", "in_progress", "done"]);
  });

  it("searches comments as well as titles, without leaking internal notes to requesters", async () => {
    const rec = (await create(req, { title: "Plain title" })).json.record;
    await ann.post(`/api/records/${rec.key}/comments`, { body: "zebracorn reconciliation", internal: true });
    expect((await ann.get("/api/records?q=zebracorn")).json.items.map((r: { key: string }) => r.key)).toEqual([rec.key]);
    expect((await req.get("/api/records?q=zebracorn")).json.items).toEqual([]);
  });

  it("filters by priority and sorts with offset cursors", async () => {
    const page1 = await ann.get("/api/records?sort=priority_desc&limit=2");
    expect(page1.json.items).toHaveLength(2);
    expect(page1.json.items[0].priority).toBe("high");
    const page2 = await ann.get(`/api/records?sort=priority_desc&limit=2&cursor=${page1.json.nextCursor}`);
    expect(page2.json.items[0].id).not.toBe(page1.json.items[0].id);
    expect((await ann.get("/api/records?priority=high")).json.items.every((r: { priority: string }) => r.priority === "high")).toBe(true);
    expect((await ann.get("/api/records?priority=bogus")).status).toBe(422);
    expect((await ann.get("/api/records?sort=bogus")).status).toBe(422);
  });
});

describe("history and trash", () => {
  it("reverts a single field change from the history", async () => {
    const rec = (await create(ann)).json.record;
    const upd = await ann.patch(`/api/records/${rec.key}`, { version: rec.version, title: "Wrong title", priority: "urgent" });
    const ev = (await ann.get(`/api/records/${rec.key}/events`)).json.events.at(-1);
    const r = await ann.post(`/api/records/${rec.key}/events/${ev.id}/revert`, { version: upd.json.record.version, field: "title" });
    expect(r.status).toBe(200);
    expect(r.json.record).toMatchObject({ title: "Invoice mismatch", priority: "urgent" });
    const again = await ann.post(`/api/records/${rec.key}/events/${ev.id}/revert`, { version: r.json.record.version, field: "title" });
    expect(again.status).toBe(409);
  });

  it("purges trashed records after the retention period, and their files", async () => {
    const rec = (await create(ann)).json.record;
    const up = await ann.upload(`/api/records/${rec.key}/attachments`, new Uint8Array([4, 5, 6]), "gone.bin");
    const key = `t/${ws.id}/a/${up.json.attachment.id}`;
    expect(blobs.objects.has(key)).toBe(true);
    await ann.delete(`/api/records/${rec.key}`);
    let result = await purgeTrash(worker(), ws.id);
    expect(result.records).toBe(0); // still within 30 days
    result = await purgeTrash(worker(), ws.id, new Date(Date.now() + 31 * 86_400_000));
    expect(result.records).toBe(1);
    expect(blobs.objects.has(key)).toBe(false);
    expect((await admin.get(`/api/records/${rec.key}`)).status).toBe(404);
  });

  it("admins can purge one record now", async () => {
    const rec = (await create(ann)).json.record;
    expect((await admin.delete(`/api/trash/records/${rec.id}`)).status).toBe(404); // not in the trash
    await ann.delete(`/api/records/${rec.key}`);
    expect((await ann.delete(`/api/trash/records/${rec.id}`)).status).toBe(403);
    expect((await admin.delete(`/api/trash/records/${rec.id}`)).status).toBe(200);
  });
});
