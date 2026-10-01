import { beforeAll, describe, expect, it } from "vitest";
import { appSql, makeApp, createWorkspace, addUser, Client, type TestWorkspace } from "./helpers.ts";

const sql = appSql();
const { app } = makeApp(sql);
let ws: TestWorkspace;
let admin: Client;

beforeAll(async () => {
  ws = await createWorkspace(sql);
  admin = await new Client(app).signIn(ws.admin.email, ws.slug);
});

describe("admin", () => {
  it("requires the admin role", async () => {
    const ag = await addUser(sql, ws, "agent");
    const agent = await new Client(app).signIn(ag.email, ws.slug);
    expect((await agent.get("/api/admin/projects")).status).toBe(403);
    expect((await agent.post("/api/admin/projects", { key: "NOPE", name: "x" })).status).toBe(403);
    expect((await new Client(app).get("/api/admin/projects")).status).toBe(401);
  });

  it("records every config change in the audit log", async () => {
    const p = await admin.post("/api/admin/projects", { key: "ITSD", name: "IT Service Desk" });
    await admin.patch(`/api/admin/projects/${p.json.project.id}`, { name: "IT Service Desk (Plant)" });
    const audit = await admin.get("/api/admin/audit");
    const entries = audit.json.entries.filter((e: { entityId: string }) => e.entityId === p.json.project.id);
    expect(entries.map((e: { action: string }) => e.action)).toEqual(["update", "create"]);
    expect(entries[0].before.name).toBe("IT Service Desk");
    expect(entries[0].after.name).toBe("IT Service Desk (Plant)");
  });

  it("keeps project keys permanent and unique", async () => {
    const p = await admin.post("/api/admin/projects", { key: "ITE", name: "IT Enhancements" });
    expect((await admin.patch(`/api/admin/projects/${p.json.project.id}`, { key: "XYZ" })).status).toBe(422);
    expect((await admin.post("/api/admin/projects", { key: "ITE", name: "Dup" })).status).toBe(409);
  });

  it("manages people and ends sessions of deactivated users", async () => {
    const created = await admin.post("/api/admin/users", { email: "Pat@Fernhollow.test", displayName: "Pat", role: "agent" });
    expect(created.status).toBe(201);
    expect(created.json.user.email).toBe("pat@fernhollow.test");
    const pat = await new Client(app).signIn("pat@fernhollow.test", ws.slug);
    expect((await pat.get("/api/me")).status).toBe(200);
    await admin.patch(`/api/admin/users/${created.json.user.id}`, { active: false });
    expect((await pat.get("/api/me")).status).toBe(401);
  });

  it("stops an admin removing their own admin access, whatever the id's letter case", async () => {
    expect((await admin.patch(`/api/admin/users/${ws.admin.id}`, { role: "agent" })).status).toBe(400);
    expect((await admin.patch(`/api/admin/users/${ws.admin.id.toUpperCase()}`, { role: "agent" })).status).toBe(400);
    expect((await admin.patch(`/api/admin/users/${ws.admin.id.toUpperCase()}`, { active: false })).status).toBe(400);
    expect((await admin.get("/api/me")).json.role).toBe("admin");
  });

  it("validates field definitions", async () => {
    const p = await admin.post("/api/admin/projects", { key: "VAL", name: "Validation" });
    const rt = await admin.post(`/api/admin/projects/${p.json.project.id}/record-types`, { key: "t", name: "T" });
    const id = rt.json.recordType.id;
    const bad = await admin.post(`/api/admin/record-types/${id}/fields`, { key: "Bad Key", label: "x", type: "text" });
    expect(bad.status).toBe(422);
    const badDefault = await admin.post(`/api/admin/record-types/${id}/fields`, {
      key: "level",
      label: "Level",
      type: "select",
      options: { choices: [{ value: "1", label: "One" }] },
      defaultValue: "2",
    });
    expect(badDefault.status).toBe(422);
    const ok = await admin.post(`/api/admin/record-types/${id}/fields`, { key: "notes", label: "Notes", type: "long_text" });
    expect(ok.status).toBe(201);
    const dup = await admin.post(`/api/admin/record-types/${id}/fields`, { key: "notes", label: "Notes", type: "text" });
    expect(dup.status).toBe(409);
  });

  it("serves compiled config without archived fields", async () => {
    const p = await admin.post("/api/admin/projects", { key: "CFG", name: "Config" });
    const rt = await admin.post(`/api/admin/projects/${p.json.project.id}/record-types`, { key: "t", name: "T" });
    const f = await admin.post(`/api/admin/record-types/${rt.json.recordType.id}/fields`, { key: "a", label: "A", type: "text" });
    await admin.patch(`/api/admin/fields/${f.json.field.id}`, { archived: true });
    const cfg = await admin.get("/api/config");
    const proj = cfg.json.projects.find((x: { key: string }) => x.key === "CFG");
    expect(proj.recordTypes[0].fields).toEqual([]);
  });
});
