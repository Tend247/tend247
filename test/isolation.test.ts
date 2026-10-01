// GATE (Phase 0): tenant isolation. One workspace can never read or write another's rows,
// at the database level and through the API.
import { describe, expect, it, beforeAll } from "vitest";
import { withTenant } from "../src/worker/db/client.ts";
import { appSql, ownerSql, makeApp, createWorkspace, addUser, Client, setupApProject, type TestWorkspace } from "./helpers.ts";

const sql = appSql();
const owner = ownerSql();
const { app } = makeApp(sql);

let a: TestWorkspace;
let b: TestWorkspace;
let aRecordId: string;
let aRecordKey: string;

beforeAll(async () => {
  a = await createWorkspace(sql, "Alpha");
  b = await createWorkspace(sql, "Beta");
  const adminA = await new Client(app).signIn(a.admin.email, a.slug);
  const { recordTypeId } = await setupApProject(adminA, "ISO");
  const r = await adminA.post("/api/records", { recordTypeId, title: "Alpha only", custom: { vendor: "Acme" } });
  expect(r.status).toBe(201);
  aRecordId = r.json.record.id;
  aRecordKey = r.json.record.key;
});

describe("row-level security", () => {
  it("every table with a tenant_id has RLS enabled and forced", async () => {
    const rows = await owner<{ table: string; enabled: boolean; forced: boolean }[]>`
      select c.relname as table, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join information_schema.columns col on col.table_schema = n.nspname and col.table_name = c.relname
      where n.nspname = 'public' and c.relkind = 'r' and col.column_name = 'tenant_id'`;
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const r of rows) expect({ table: r.table, enabled: r.enabled, forced: r.forced }).toEqual({ table: r.table, enabled: true, forced: true });
  });

  it("the app role is neither superuser nor BYPASSRLS", async () => {
    const [role] = await sql<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      select rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("shows nothing when no workspace is set", async () => {
    for (const table of ["users", "projects", "records", "record_events", "audit_log", "outbox", "sessions", "field_defs"]) {
      const [row] = await sql.unsafe(`select count(*)::int as n from ${table}`);
      expect({ table, n: row!.n }).toEqual({ table, n: 0 });
    }
  });

  it("hides workspace A's rows from workspace B", async () => {
    await withTenant(sql, b.id, async (tx) => {
      for (const table of ["projects", "record_types", "field_defs", "records", "record_events", "audit_log", "outbox"]) {
        const [row] = await tx.unsafe(`select count(*)::int as n from ${table}`);
        expect({ table, n: row!.n }).toEqual({ table, n: 0 });
      }
      const users = await tx<{ id: string }[]>`select id from users`;
      expect(users.map((u) => u.id)).toEqual([b.admin.id]);
      const updated = await tx`update records set title = 'hijacked' where id = ${aRecordId}`;
      expect(updated.count).toBe(0);
    });
  });

  it("rejects writing a row into another workspace", async () => {
    await expect(
      withTenant(sql, b.id, (tx) => tx`insert into projects (tenant_id, key, name) values (${a.id}, 'EVIL', 'x')`),
    ).rejects.toThrow(/row-level security/);
  });

  it("rejects pointing a record at a person in another workspace", async () => {
    await expect(
      withTenant(sql, a.id, (tx) => tx`update records set assignee_id = ${b.admin.id} where id = ${aRecordId}`),
    ).rejects.toThrow(/foreign key/);
  });

  it("keeps history append-only", async () => {
    await expect(withTenant(sql, a.id, (tx) => tx`update record_events set kind = 'x'`)).rejects.toThrow(/append-only/);
    await expect(withTenant(sql, a.id, (tx) => tx`delete from audit_log`)).rejects.toThrow(/append-only/);
    await expect(withTenant(sql, a.id, (tx) => tx`delete from record_events`)).rejects.toThrow(/append-only/);
  });

  it("deleting a whole workspace (an expired sandbox) removes its history too", async () => {
    const temp = await createWorkspace(sql, "Sandbox");
    const admin = await new Client(app).signIn(temp.admin.email, temp.slug);
    const { recordTypeId } = await setupApProject(admin, "TMP");
    expect((await admin.post("/api/records", { recordTypeId, title: "x", custom: { vendor: "V" } })).status).toBe(201);
    await sql`delete from tenants where id = ${temp.id}`;
    const left = await owner<{ n: number }[]>`
      select (select count(*) from record_events where tenant_id = ${temp.id})::int
           + (select count(*) from audit_log where tenant_id = ${temp.id})::int as n`;
    expect(left[0]!.n).toBe(0);
  });
});

describe("API isolation", () => {
  it("returns 404 for another workspace's record, by id and by key", async () => {
    const adminB = await new Client(app).signIn(b.admin.email, b.slug);
    expect((await adminB.get(`/api/records/${aRecordId}`)).status).toBe(404);
    expect((await adminB.get(`/api/records/${aRecordKey}`)).status).toBe(404);
    expect((await adminB.patch(`/api/records/${aRecordId}`, { version: 1, title: "x" })).status).toBe(404);
    expect((await adminB.delete(`/api/records/${aRecordId}`)).status).toBe(404);
    const list = await adminB.get("/api/records");
    expect(list.json.items).toEqual([]);
  });

  it("refuses to assign a person from another workspace through the API", async () => {
    const adminA = await new Client(app).signIn(a.admin.email, a.slug);
    const r = await adminA.patch(`/api/records/${aRecordId}`, { version: 1, assigneeId: b.admin.id });
    expect(r.json).toMatchObject({ error: { code: "validation_failed" } });
    expect(r.status).toBe(422);
  });

  it("a session cookie cannot be replayed against another workspace", async () => {
    const adminA = await new Client(app).signIn(a.admin.email, a.slug);
    const token = adminA.cookie.split("t247_session=")[1]!.split(".")[1]!;
    const forged = new Client(app);
    forged.cookie = `t247_session=${b.id}.${token}`;
    expect((await forged.get("/api/me")).status).toBe(401);
  });

  it("a requester only sees their own records", async () => {
    const requester = await addUser(sql, a, "requester");
    const client = await new Client(app).signIn(requester.email, a.slug);
    expect((await client.get(`/api/records/${aRecordId}`)).status).toBe(404);
    expect((await client.get("/api/records")).json.items).toEqual([]);
  });
});
