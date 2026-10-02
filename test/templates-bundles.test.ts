// Phase 3: starter templates, the Fernhollow builder, and whole-workspace bundles (export,
// import as a new workspace with fresh ids, time shift, delete).
import { describe, expect, it, beforeAll } from "vitest";
import { withTenant } from "../src/worker/db/client.ts";
import { buildFernhollow } from "../src/worker/demo/fernhollow.ts";
import { TEMPLATES } from "../src/worker/templates/catalog.ts";
import { countRows, decodeWorkspace, deleteWorkspace, encodeWorkspace, importWorkspace, readWorkspace } from "../src/worker/workspace/bundle.ts";
import { MemoryBlobStore } from "../src/worker/attachments/blobs.ts";
import { appSql, makeApp, createWorkspace, addUser, Client, unique, type TestWorkspace } from "./helpers.ts";

const sql = appSql();
const blobs = new MemoryBlobStore();
const { app } = makeApp(sql, { blobs });

describe("starter templates", () => {
  let ws: TestWorkspace;
  let admin: Client;
  beforeAll(async () => {
    ws = await createWorkspace(sql);
    admin = await new Client(app).signIn(ws.admin.email, ws.slug);
  });

  it("lists the built-in templates", async () => {
    const r = await admin.get("/api/admin/templates");
    expect(r.json.templates.map((t: { name: string }) => t.name)).toEqual(["HR Cases", "IT Service Desk", "IT Enhancements", "AP Requests", "Agile Software Team"]);
    expect(r.json.saved).toEqual([]);
  });

  it("installs each template as ordinary, published configuration", async () => {
    for (const { key, definition: t } of TEMPLATES) {
      const r = await admin.post(`/api/admin/templates/${key}/install`, {});
      expect(r.status, JSON.stringify(r.json)).toBe(201);
      expect(r.json.project).toMatchObject({ key: t.project.key, restricted: t.project.restricted, assignment: t.project.assignment, agile: t.project.agile });
      expect(Object.keys(r.json.recordTypeIds)).toEqual(t.recordTypes.map((x) => x.key));
      const wf = await admin.get(`/api/admin/config/workflow/${r.json.recordTypeId}`);
      const first = t.recordTypes.find((x) => !x.isEpic)!;
      expect(wf.json.published.definition.statuses.map((s: { key: string }) => s.key)).toEqual(first.workflow.statuses.map((s) => s.key));
      const approval = wf.json.published.definition.transitions.find((x: { approval?: unknown }) => x.approval);
      if (approval) expect(approval.approval.approvers).toEqual([ws.admin.id]);
      if (t.sla) {
        const sla = await admin.get(`/api/admin/config/sla/${r.json.project.id}`);
        const business = sla.json.published.definition.policies.find((p: { calendarId: string | null }) => p.calendarId);
        expect(business?.calendarId ?? null).toBe(r.json.calendarId);
      }
    }
    const teams = await admin.get("/api/admin/teams");
    expect(teams.json.teams.map((t: { name: string }) => t.name).sort()).toEqual(["Accounts payable", "People Ops", "Product engineering", "Service desk"]);
    const cals = await admin.get("/api/admin/calendars");
    expect(cals.json.calendars.map((c: { name: string }) => c.name)).toEqual(["Business hours"]);
  });

  it("refuses a duplicate project key, and accepts an override", async () => {
    const dup = await admin.post("/api/admin/templates/hr_cases/install", {});
    expect(dup.status).toBe(422);
    const ok = await admin.post("/api/admin/templates/hr_cases/install", { projectKey: "HR2", projectName: "HR Cases (Plant 2)" });
    expect(ok.status).toBe(201);
    expect(ok.json.project.name).toBe("HR Cases (Plant 2)");
  });

  it("an installed queue takes requests straight away", async () => {
    const cfg = await admin.get("/api/config");
    const itsd = cfg.json.projects.find((p: { key: string }) => p.key === "ITSD");
    const r = await admin.post("/api/records", { recordTypeId: itsd.recordTypes[0].id, title: "Printer jam", custom: { site: "office" }, priority: "urgent" });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const detail = await admin.get(`/api/records/${r.json.record.key}`);
    expect(detail.json.sla.map((c: { policyName: string }) => c.policyName)).toContain("Line down");
  });

  it("is admin-only", async () => {
    const agent = await addUser(sql, ws, "agent");
    const c = await new Client(app).signIn(agent.email, ws.slug);
    expect((await c.post("/api/admin/templates/ap_requests/install", {})).status).toBe(403);
    expect((await c.get("/api/admin/workspace/export")).status).toBe(403);
  });
});

describe("workspace bundles", () => {
  let sourceId: string;
  let sourceSlug: string;

  beforeAll(async () => {
    sourceSlug = unique("fern").toLowerCase();
    const [t] = await sql<{ id: string }[]>`
      insert into tenants (slug, name, settings) values (${sourceSlug}, 'Fernhollow Foods', ${sql.json({ timezone: "America/Chicago" })}) returning id`;
    sourceId = t!.id;
    await withTenant(sql, sourceId, (tx) => buildFernhollow(tx, sourceId));
  });

  it("the Fernhollow builder makes the sample workspace", async () => {
    const data = await readWorkspace(sql, sourceId);
    const counts = countRows(data);
    expect(counts.users).toBe(6);
    expect(counts.projects).toBe(5);
    expect(counts.records).toBeGreaterThanOrEqual(15);
    expect(counts.automation_rules).toBe(3);
    // The agile team: two finished sprints, one running, one planned, with a moving burndown.
    expect(data.tables.sprints!.map((s) => s.state).sort()).toEqual(["active", "completed", "completed", "planned"]);
    expect(counts.sprint_snapshots).toBeGreaterThanOrEqual(15);
    expect(data.tables.records!.filter((r) => r.epic_id).length).toBeGreaterThanOrEqual(10);
    expect(counts.approvals).toBeGreaterThanOrEqual(2);
  });

  it("round-trips through the bundle format and imports with fresh ids", async () => {
    const data = await readWorkspace(sql, sourceId);
    const bytes = await encodeWorkspace(data);
    const decoded = await decodeWorkspace(bytes);
    expect(countRows(decoded)).toEqual(countRows(data));

    const shift = 3 * 86_400_000;
    const slug = unique("copy").toLowerCase();
    const result = await importWorkspace(sql, decoded, { slug, timeShiftMs: shift });
    expect(result.counts).toEqual(countRows(data));

    const copy = await readWorkspace(sql, result.tenantId);
    expect(countRows(copy)).toEqual(countRows(data));
    const srcIds = new Set(data.tables.records!.map((r) => r.id));
    for (const r of copy.tables.records!) expect(srcIds.has(r.id)).toBe(false);
    // Same keys, references followed to the new rows.
    expect(copy.tables.records!.map((r) => r.key).sort()).toEqual(data.tables.records!.map((r) => r.key).sort());
    const userIds = new Set(copy.tables.users!.map((u) => u.id));
    for (const r of copy.tables.records!) {
      if (r.assignee_id) expect(userIds.has(r.assignee_id)).toBe(true);
      if (r.requester_id) expect(userIds.has(r.requester_id)).toBe(true);
    }
    const calendarIds = new Set(copy.tables.calendars!.map((c) => c.id));
    const sla = copy.tables.config_versions!.find((v) => v.kind === "sla" && v.state === "published")!;
    for (const p of (sla.definition as { policies: { calendarId: string | null }[] }).policies) {
      if (p.calendarId) expect(calendarIds.has(p.calendarId)).toBe(true);
    }
    const wf = copy.tables.config_versions!.filter((v) => v.kind === "workflow");
    const approvers = wf.flatMap((v) => (v.definition as { transitions: { approval?: { approvers: string[] } }[] }).transitions.flatMap((t) => t.approval?.approvers ?? []));
    expect(approvers.length).toBeGreaterThan(0);
    for (const a of approvers) expect(userIds.has(a)).toBe(true);
    // Pending approvals survive the deferred foreign key.
    expect(copy.tables.records!.filter((r) => r.pending_approval_id).length).toBe(data.tables.records!.filter((r) => r.pending_approval_id).length);
    // Timestamps moved by the shift.
    const firstSrc = data.tables.records!.find((r) => r.key === "FIN-1")!;
    const firstCopy = copy.tables.records!.find((r) => r.key === "FIN-1")!;
    expect(Date.parse(firstCopy.created_at as string) - Date.parse(firstSrc.created_at as string)).toBeCloseTo(shift, -2);

    // The copy works: people can sign in and see their work.
    const sam = await new Client(app).signIn("sam@fernhollow.test", slug);
    const list = await sam.get("/api/records?limit=100");
    expect(list.json.items.length).toBeGreaterThan(5);
  });

  it("copies attachment files with the bundle", async () => {
    const slug = unique("att").toLowerCase();
    const ws = await importWorkspace(sql, await readWorkspace(sql, sourceId), { slug });
    const admin = await new Client(app).signIn("admin@fernhollow.test", slug);
    const up = await admin.upload("/api/records/ITSD-1/attachments", new TextEncoder().encode("hello"), "note.txt", "text/plain");
    expect(up.status).toBe(201);
    const target = new MemoryBlobStore();
    const second = await importWorkspace(sql, await readWorkspace(sql, ws.tenantId), { slug: unique("att2").toLowerCase(), blobs: { from: blobs, to: target } });
    expect(second.missingFiles).toBe(0);
    expect([...target.objects.keys()].every((k) => k.startsWith(`t/${second.tenantId}/a/`))).toBe(true);
    expect(target.objects.size).toBe(1);
  });

  it("the admin download is a bundle of the whole workspace", async () => {
    const admin = await new Client(app).signIn("admin@fernhollow.test", sourceSlug);
    const res = await admin.raw("/api/admin/workspace/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename=".+\.tend247\.ndjson\.gz"/);
    const data = await decodeWorkspace(new Uint8Array(await res.arrayBuffer()));
    expect(data.header.workspace.slug).toBe(sourceSlug);
    expect(countRows(data).records).toBeGreaterThanOrEqual(15);
    // No secrets travel in a bundle.
    expect(Object.keys(data.tables)).not.toContain("sessions");
    expect(JSON.stringify(data)).not.toContain("webhook_secret");
  });

  it("refuses a bundle whose rows claim another workspace", async () => {
    const data = await readWorkspace(sql, sourceId);
    const other = await createWorkspace(sql, "Victim");
    data.tables.users!.push({ ...data.tables.users![0]!, id: crypto.randomUUID(), email: "intruder@evil.test", tenant_id: other.id });
    await expect(importWorkspace(sql, data, { slug: unique("evil").toLowerCase() })).rejects.toThrow(/another workspace/);
  });

  it("an inert copy has webhooks and automation off", async () => {
    const ws = await importWorkspace(sql, await readWorkspace(sql, sourceId), { slug: unique("inert").toLowerCase(), inert: true });
    const rules = await sql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${ws.tenantId}, true)`;
      return tx<{ enabled: boolean }[]>`select enabled from automation_rules`;
    });
    expect(rules.length).toBe(3);
    expect(rules.every((r) => !r.enabled)).toBe(true);
    expect((await sql`select 1 from scheduled_jobs where tenant_id = ${ws.tenantId}`).length).toBe(0);
  });

  it("rejects damaged bundles", async () => {
    const bytes = await encodeWorkspace(await readWorkspace(sql, sourceId));
    const text = new TextDecoder().decode(new Uint8Array(await new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()));
    const lines = text.trim().split("\n");
    await expect(decodeWorkspace(new TextEncoder().encode(lines.slice(0, -1).join("\n")))).rejects.toThrow(/truncated/);
    await expect(decodeWorkspace(new TextEncoder().encode([...lines.slice(0, 3), ...lines.slice(-1)].join("\n")))).rejects.toThrow(/damaged/);
  });

  it("deletes a workspace with its files", async () => {
    const slug = unique("del").toLowerCase();
    const ws = await importWorkspace(sql, await readWorkspace(sql, sourceId), { slug });
    await blobs.put(`t/${ws.tenantId}/a/x`, new Uint8Array([1]), "application/octet-stream");
    await deleteWorkspace(sql, ws.tenantId, [blobs]);
    expect((await sql`select 1 from tenants where id = ${ws.tenantId}`).length).toBe(0);
    expect(await blobs.list(`t/${ws.tenantId}/`)).toEqual([]);
  });
});
