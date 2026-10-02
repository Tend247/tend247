// Agile projects: ranked backlog, sprints (plan → start → complete with carry-over), story
// points, epics, burndown and velocity, the sprint board, tokens and workspace bundles.
import { describe, expect, it, beforeAll } from "vitest";
import { importWorkspace, readWorkspace } from "../src/worker/workspace/bundle.ts";
import { appSql, makeApp, createWorkspace, addUser, Client, unique, type TestWorkspace } from "./helpers.ts";

const sql = appSql();
const { app } = makeApp(sql);
const DAY = 86_400_000;

describe("agile projects", () => {
  let ws: TestWorkspace;
  let admin: Client;
  let projectId: string;
  let types: Record<string, string>;
  const keys: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let sprint1: string;
  let sprint2: string;

  const story = async (title: string, storyPoints: number | null, epicId?: string) => {
    const r = await admin.post("/api/records", { recordTypeId: types.story, title, storyPoints, ...(epicId ? { epicId } : {}) });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    keys[title] = r.json.record.key;
    ids[title] = r.json.record.id;
    return r.json.record;
  };
  const backlog = async () => (await admin.get(`/api/projects/${projectId}/backlog`)).json;

  beforeAll(async () => {
    ws = await createWorkspace(sql);
    admin = await new Client(app).signIn(ws.admin.email, ws.slug);
    const r = await admin.post("/api/admin/templates/agile_team/install", {});
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    projectId = r.json.project.id;
    types = r.json.recordTypeIds;
  });

  it("installs as an agile project with an epic type", async () => {
    const cfg = await admin.get("/api/config");
    const p = cfg.json.projects.find((x: { id: string }) => x.id === projectId);
    expect(p.agile).toBe(true);
    expect(p.recordTypes.filter((t: { isEpic: boolean }) => t.isEpic).map((t: { key: string }) => t.key)).toEqual(["epic"]);
  });

  it("records carry story points and an epic", async () => {
    const epic = await admin.post("/api/records", { recordTypeId: types.epic, title: "Checkout" });
    expect(epic.status).toBe(201);
    ids.epic = epic.json.record.id;
    const s1 = await story("Pay by card", 3, ids.epic);
    expect(s1).toMatchObject({ storyPoints: 3, epicId: ids.epic, epicKey: epic.json.record.key, epicTitle: "Checkout" });
    await story("Save address", 5, ids.epic);
    await story("Order email", 2, ids.epic);
    await story("Guest checkout", 8);

    // Points: one decimal place at most; epics cannot nest; the epic must be an epic.
    expect((await admin.post("/api/records", { recordTypeId: types.story, title: "x", storyPoints: 2.55 })).status).toBe(422);
    expect((await admin.post("/api/records", { recordTypeId: types.story, title: "Tiny", storyPoints: 0.3 })).status).toBe(201);
    expect((await admin.post("/api/records", { recordTypeId: types.epic, title: "x", epicId: ids.epic })).status).toBe(422);
    expect((await admin.post("/api/records", { recordTypeId: types.story, title: "x", epicId: ids["Pay by card"] })).status).toBe(422);
    const tiny = await admin.get("/api/records?q=Tiny");
    await admin.delete(`/api/records/${tiny.json.items[0].key}`);

    const filtered = await admin.get(`/api/records?projectId=${projectId}&epicId=${ids.epic}`);
    expect(filtered.json.items.length).toBe(3);
    const none = await admin.get(`/api/records?projectId=${projectId}&epicId=none&sprintId=backlog`);
    expect(none.json.items.map((r: { title: string }) => r.title).sort()).toEqual(["Checkout", "Guest checkout"]);
  });

  it("the backlog is ranked, and reordering is not an edit", async () => {
    let b = await backlog();
    expect(b.backlog.map((r: { title: string }) => r.title)).toEqual(["Pay by card", "Save address", "Order email", "Guest checkout"]);
    expect(b.epics).toEqual([expect.objectContaining({ title: "Checkout", count: 3, points: 10, doneCount: 0 })]);

    const before = (await admin.get(`/api/records/${keys["Guest checkout"]}`)).json.record.version;
    const moved = await admin.post(`/api/records/${keys["Guest checkout"]}/plan`, { beforeId: ids["Pay by card"] });
    expect(moved.status, JSON.stringify(moved.json)).toBe(200);
    expect(moved.json.record.version).toBe(before);
    await admin.post(`/api/records/${keys["Order email"]}/plan`, { afterId: ids["Guest checkout"], beforeId: ids["Pay by card"] });
    b = await backlog();
    expect(b.backlog.map((r: { title: string }) => r.title)).toEqual(["Guest checkout", "Order email", "Pay by card", "Save address"]);
    const events = await admin.get(`/api/records/${keys["Guest checkout"]}/events`);
    expect(events.json.events.some((e: { kind: string }) => e.kind === "planned")).toBe(false);
  });

  it("keeps order when many cards are dropped into the same gap", async () => {
    // Repeated midpoints shrink the gap until the project is renumbered.
    for (let i = 0; i < 60; i++) {
      const [a, b] = i % 2 ? ["Order email", "Pay by card"] : ["Pay by card", "Order email"];
      const r = await admin.post(`/api/records/${keys[a]}/plan`, { afterId: ids["Guest checkout"], beforeId: ids[b] });
      expect(r.status).toBe(200);
    }
    const b = await backlog();
    expect(b.backlog.map((r: { title: string }) => r.title)).toEqual(["Guest checkout", "Order email", "Pay by card", "Save address"]);
    const ranks = b.backlog.map((r: { rank: number }) => r.rank);
    expect(new Set(ranks).size).toBe(4);
  });

  it("places a record next to one neighbour without jumping past the next", async () => {
    let b = await backlog();
    const [a, , c] = b.backlog.map((r: { id: string; key: string; title: string }) => r);
    // Move the third item to just after the first: it must land second, not tie with the second.
    expect((await admin.post(`/api/records/${c.key}/plan`, { afterId: a.id })).status).toBe(200);
    b = await backlog();
    expect(b.backlog[1].id).toBe(c.id);
    // Neighbours in the wrong order fall back to the first one given.
    expect((await admin.post(`/api/records/${c.key}/plan`, { afterId: b.backlog[3].id, beforeId: b.backlog[0].id })).status).toBe(200);
    b = await backlog();
    expect(b.backlog[3].id).toBe(c.id);
    // Put things back as the next tests expect.
    await admin.post(`/api/records/${keys["Pay by card"]}/plan`, { afterId: ids["Order email"], beforeId: ids["Save address"] });
    b = await backlog();
    expect(b.backlog.map((r: { title: string }) => r.title)).toEqual(["Guest checkout", "Order email", "Pay by card", "Save address"]);
  });

  it("plans work into a sprint", async () => {
    const s = await admin.post(`/api/projects/${projectId}/sprints`, {});
    expect(s.status).toBe(201);
    expect(s.json.sprint).toMatchObject({ name: "APP Sprint 1", state: "planned", points: 0 });
    sprint1 = s.json.sprint.id;
    for (const t of ["Guest checkout", "Pay by card"]) {
      const r = await admin.post(`/api/records/${keys[t]}/plan`, { sprintId: sprint1 });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      expect(r.json.record.sprintId).toBe(sprint1);
    }
    const events = await admin.get(`/api/records/${keys["Pay by card"]}/events`);
    expect(events.json.events.find((e: { kind: string }) => e.kind === "planned").data).toMatchObject({ from: null, to: "APP Sprint 1" });
    expect((await admin.post(`/api/records/${keys["Pay by card"]}/plan`, { sprintId: sprint1, afterId: ids["Guest checkout"] })).status).toBe(200);

    // Epics are not planned into sprints.
    const epicKey = (await admin.get(`/api/records/${ids.epic}`)).json.record.key;
    expect((await admin.post(`/api/records/${epicKey}/plan`, { sprintId: sprint1 })).status).toBe(422);

    const b = await backlog();
    expect(b.sprints[0]).toMatchObject({ id: sprint1, points: 11, count: 2 });
    expect(b.sprints[0].records.map((r: { title: string }) => r.title)).toEqual(["Guest checkout", "Pay by card"]);
    expect(b.backlog.map((r: { title: string }) => r.title)).toEqual(["Order email", "Save address"]);
  });

  it("starts one sprint at a time and records the commitment", async () => {
    const s2 = await admin.post(`/api/projects/${projectId}/sprints`, { goal: "Finish checkout" });
    sprint2 = s2.json.sprint.id;
    expect(s2.json.sprint.name).toBe("APP Sprint 2");

    const started = await admin.post(`/api/sprints/${sprint1}/start`, { startAt: new Date(Date.now() - 3 * DAY).toISOString(), weeks: 2, goal: "Take payments" });
    expect(started.status, JSON.stringify(started.json)).toBe(200);
    expect(started.json.sprint).toMatchObject({ state: "active", committedPoints: 11, committedCount: 2, goal: "Take payments" });
    const moved = await admin.patch(`/api/sprints/${sprint1}`, { startAt: new Date().toISOString() });
    expect(moved.status).toBe(422);
    const again = await admin.post(`/api/sprints/${sprint2}/start`, {});
    expect(again.status).toBe(409);
    expect(again.json.error.message).toMatch(/Complete "APP Sprint 1"/);
    expect((await admin.delete(`/api/sprints/${sprint1}`)).status).toBe(409);
  });

  it("draws the sprint board by status", async () => {
    const r = await admin.get(`/api/board?projectId=${projectId}&sprintId=active&columns=status&sort=rank_asc`);
    expect(r.status).toBe(200);
    expect(r.json.columns.map((c: { key: string }) => c.key)).toEqual(["todo", "in_progress", "in_review", "done"]);
    expect(r.json.columns[0].records.map((x: { title: string }) => x.title)).toEqual(["Guest checkout", "Pay by card"]);
  });

  it("burns down as work is done and scope changes", async () => {
    const done = await admin.post(`/api/records/${keys["Pay by card"]}/transitions`, { transition: "to_done" });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    const v = (await admin.get(`/api/records/${keys["Guest checkout"]}`)).json.record.version;
    expect((await admin.patch(`/api/records/${keys["Guest checkout"]}`, { version: v, storyPoints: 5 })).status).toBe(200);

    const r = await admin.get(`/api/sprints/${sprint1}/report`);
    expect(r.status).toBe(200);
    expect(r.json.days.length).toBe(15);
    expect(r.json.days.slice(0, 5).map((d: { remaining: number | null }) => d.remaining)).toEqual([11, 11, 11, 5, null]);
    expect(r.json.days[0].ideal).toBe(11);
    expect(r.json.days[14].ideal).toBe(0);
    expect(r.json.days[3].scope).toBe(8);
    expect(r.json.scopeChange).toBe(-3);
    expect(r.json.sprint).toMatchObject({ points: 8, donePoints: 3 });
  });

  it("completes a sprint and carries unfinished work over", async () => {
    const bad = await admin.post(`/api/sprints/${sprint1}/complete`, { moveTo: sprint1 });
    expect(bad.status).toBe(422);
    const r = await admin.post(`/api/sprints/${sprint1}/complete`, { moveTo: sprint2 });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.moved).toBe(1);
    expect(r.json.sprint).toMatchObject({ state: "completed", completedPoints: 3, completedCount: 1 });
    const guest = (await admin.get(`/api/records/${keys["Guest checkout"]}`)).json.record;
    expect(guest.sprintId).toBe(sprint2);
    const events = await admin.get(`/api/records/${keys["Guest checkout"]}/events`);
    expect(events.json.events.filter((e: { kind: string }) => e.kind === "planned").at(-1).data).toMatchObject({ to: "APP Sprint 2", reason: "sprint_completed" });

    const vel = await admin.get(`/api/projects/${projectId}/velocity`);
    expect(vel.json.sprints).toEqual([expect.objectContaining({ name: "APP Sprint 1", committed: 11, completed: 3 })]);
    expect(vel.json.average).toBe(3);

    // A completed sprint is history: it cannot change, and nothing can be planned into it.
    expect((await admin.patch(`/api/sprints/${sprint1}`, { name: "Renamed" })).status).toBe(409);
    expect((await admin.post(`/api/records/${keys["Order email"]}/plan`, { sprintId: sprint1 })).status).toBe(422);
    const report = await admin.get(`/api/sprints/${sprint1}/report`);
    expect(report.json.days.at(-1).remaining).toBe(5);
    // Finished work stays with the sprint it was finished in…
    expect((await admin.post(`/api/records/${keys["Pay by card"]}/plan`, { sprintId: null })).status).toBe(409);
    // …until it is reopened, which puts it back in the backlog.
    expect((await admin.post(`/api/records/${keys["Pay by card"]}/transitions`, { transition: "to_in_progress" })).status).toBe(200);
    const reopened = (await admin.get(`/api/records/${keys["Pay by card"]}`)).json.record;
    expect(reopened.sprintId).toBeNull();
    expect((await backlog()).backlog.map((r: { title: string }) => r.title)).toContain("Pay by card");
    await admin.post(`/api/records/${keys["Pay by card"]}/transitions`, { transition: "to_done" });
  });

  it("deleting a planned sprint returns its work to the backlog", async () => {
    expect((await admin.delete(`/api/sprints/${sprint2}`)).status).toBe(200);
    const b = await backlog();
    expect(b.sprints).toEqual([]);
    expect(b.backlog.map((r: { title: string }) => r.title)).toContain("Guest checkout");
    expect(b.epics[0]).toMatchObject({ doneCount: 1, donePoints: 3 });
  });

  it("shows an epic's title only to people who can open the epic", async () => {
    await admin.patch(`/api/admin/projects/${projectId}`, { requesterAccess: true });
    const requester = await addUser(sql, ws, "requester");
    const req = await new Client(app).signIn(requester.email, ws.slug);
    const mine = await req.post("/api/records", { recordTypeId: types.story, title: "Please add Apple Pay" });
    expect(mine.status, JSON.stringify(mine.json)).toBe(201);
    expect(mine.json.record.storyPoints).toBeNull();
    const v = (await admin.get(`/api/records/${mine.json.record.key}`)).json.record.version;
    expect((await admin.patch(`/api/records/${mine.json.record.key}`, { version: v, epicId: ids.epic })).status).toBe(200);
    const seen = (await req.get(`/api/records/${mine.json.record.key}`)).json.record;
    expect(seen.epicId).toBe(ids.epic);
    expect(seen.epicTitle).toBeNull();
    expect(seen.epicKey).toBeNull();
    expect((await admin.get(`/api/records/${mine.json.record.key}`)).json.record.epicTitle).toBe("Checkout");
    await admin.patch(`/api/admin/projects/${projectId}`, { requesterAccess: false });
  });

  it("is for staff, and for agile projects only", async () => {
    const agent = await addUser(sql, ws, "agent");
    const a = await new Client(app).signIn(agent.email, ws.slug);
    expect((await a.get(`/api/projects/${projectId}/backlog`)).status).toBe(200);
    const s = await a.post(`/api/projects/${projectId}/sprints`, { name: "Agent sprint" });
    expect(s.status).toBe(201);
    await a.delete(`/api/sprints/${s.json.sprint.id}`);

    const requester = await addUser(sql, ws, "requester");
    const req = await new Client(app).signIn(requester.email, ws.slug);
    expect((await req.get(`/api/projects/${projectId}/backlog`)).status).toBe(403);
    expect((await req.post(`/api/records/${keys["Order email"]}/plan`, { sprintId: null })).status).toBe(403);

    const other = await admin.post("/api/admin/templates/it_service_desk/install", {});
    expect((await admin.get(`/api/projects/${other.json.project.id}/backlog`)).status).toBe(409);
    // Turning agile on later: existing records are listed in creation order, and reading the
    // backlog changes nothing.
    const cfg = (await admin.get("/api/config")).json;
    const itsdType = cfg.projects.find((p: { id: string }) => p.id === other.json.project.id).recordTypes[0].id;
    for (const t of ["First", "Second"]) await admin.post("/api/records", { recordTypeId: itsdType, title: t, custom: { site: "office" } });
    await admin.patch(`/api/admin/projects/${other.json.project.id}`, { agile: true });
    const bl = await admin.get(`/api/projects/${other.json.project.id}/backlog`);
    expect(bl.json.backlog.map((r: { title: string }) => r.title)).toEqual(["First", "Second"]);
    expect(bl.json.backlog.every((r: { rank: number | null }) => r.rank === null)).toBe(true);
    expect((await admin.get(`/api/projects/not-a-uuid/backlog`)).status).toBe(404);
  });

  it("keeps a restricted project's plan to its team", async () => {
    const outsider = await addUser(sql, ws, "agent");
    const o = await new Client(app).signIn(outsider.email, ws.slug);
    expect((await admin.patch(`/api/admin/projects/${projectId}`, { restricted: true })).status).toBe(200);
    expect((await o.get(`/api/projects/${projectId}/backlog`)).status).toBe(404);
    expect((await o.get(`/api/sprints/${sprint1}/report`)).status).toBe(404);
    expect((await o.get(`/api/projects/${projectId}/velocity`)).status).toBe(404);
    const cfg = await admin.get("/api/config");
    const teamId = cfg.json.projects.find((p: { id: string }) => p.id === projectId).defaultTeamId;
    const team = (await admin.get("/api/admin/teams")).json.teams.find((t: { id: string }) => t.id === teamId);
    await admin.patch(`/api/admin/teams/${teamId}`, { memberIds: [...team.members.map((m: { id: string }) => m.id), outsider.id] });
    expect((await o.get(`/api/projects/${projectId}/backlog`)).status).toBe(200);
    await admin.patch(`/api/admin/projects/${projectId}`, { restricted: false });
  });

  it("API tokens need records:write to plan", async () => {
    const t = await admin.post("/api/tokens", { name: "Reports", scopes: ["records:read"] });
    const auth = { authorization: `Bearer ${t.json.secret}` };
    const read = await app.request(`http://localhost/api/projects/${projectId}/backlog`, { headers: auth });
    expect(read.status).toBe(200);
    const write = await app.request(`http://localhost/api/projects/${projectId}/sprints`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: "{}",
    });
    expect(write.status).toBe(403);
  });

  it("travels in a workspace bundle with epics, sprints and snapshots", async () => {
    const data = await readWorkspace(sql, ws.id);
    expect(data.tables.sprints!.length).toBeGreaterThanOrEqual(1);
    expect(data.tables.sprint_snapshots!.length).toBeGreaterThanOrEqual(2);
    const copy = await importWorkspace(sql, data, { slug: unique("agile").toLowerCase() });
    const out = await readWorkspace(sql, copy.tenantId);
    const epic = out.tables.records!.find((r) => r.title === "Checkout")!;
    expect(out.tables.records!.filter((r) => r.epic_id === epic.id).length).toBe(4);
    const sprint = out.tables.sprints!.find((s) => s.name === "APP Sprint 1")!;
    expect(sprint.id).not.toBe(sprint1);
    expect(out.tables.sprint_snapshots!.every((s) => s.sprint_id === sprint.id)).toBe(true);
  });
});
