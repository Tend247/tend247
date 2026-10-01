// Phase 2: nightly export (chunked, gzipped NDJSON, optional AES-GCM), retention, backup health,
// failure alerts, and rebuild after restore.
import { describe, expect, it, beforeAll } from "vitest";
import { MemoryBlobStore } from "../src/worker/attachments/blobs.ts";
import { decodeExportFile, pruneExports, runExportStep } from "../src/worker/backup/export.ts";
import { rebuildAfterRestore, runDueJobs, sweep } from "../src/worker/jobs/runner.ts";
import { withTenant } from "../src/worker/db/client.ts";
import { appSql, makeApp, createWorkspace, Client, setupApProject, baseConfig, type TestWorkspace } from "./helpers.ts";

const sql = appSql();
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const backups = new MemoryBlobStore();
let clock = new Date("2026-10-07T07:00:00Z");
const { app, worker } = makeApp(sql, {
  backups,
  now: () => clock,
  config: { backup: { ...baseConfig.backup, encryptionKey: KEY, dailyKeep: 3, monthlyKeep: 2 } },
});

let ws: TestWorkspace;
let admin: Client;

beforeAll(async () => {
  ws = await createWorkspace(sql);
  admin = await new Client(app).signIn(ws.admin.email, ws.slug);
  const { recordTypeId } = await setupApProject(admin, "BK");
  for (let i = 0; i < 3; i++) {
    const r = await admin.post("/api/records", { recordTypeId, title: `Record ${i}`, custom: { vendor: "Acme" } });
    await admin.post(`/api/records/${r.json.record.key}/comments`, { body: `note ${i}` });
  }
  await withTenant(sql, ws.id, (tx) => tx`insert into sessions (token_hash, tenant_id, user_id, expires_at) values ('secret-hash', ${ws.id}, ${ws.admin.id}, now() + interval '1 day')`);
});

describe("nightly export", () => {
  it("writes every table in chunks, encrypted, with a manifest", async () => {
    let more = true;
    let steps = 0;
    while (more && steps < 20) {
      more = await runExportStep(worker(), ws.id);
      steps++;
    }
    expect(steps).toBeGreaterThan(1); // chunked across timer steps
    const keys = await backups.list(`exports/${ws.slug}/2026-10-07/`);
    expect(keys).toContain(`exports/${ws.slug}/2026-10-07/manifest.json`);
    const manifest = JSON.parse(new TextDecoder().decode((await backups.get(`exports/${ws.slug}/2026-10-07/manifest.json`))!.body as Uint8Array));
    expect(manifest).toMatchObject({ format: "tend247-export", version: 1, encrypted: true, workspace: { slug: ws.slug } });
    expect(manifest.schema).toMatch(/^0002_/);
    expect(manifest.tables.records.rows).toBe(3);
    expect(manifest.tables.comments.rows).toBe(3);
    expect(manifest.tables.sessions).toBeUndefined(); // secrets are never exported

    const part = manifest.tables.records.parts[0];
    const raw = (await backups.get(part))!.body as Uint8Array;
    expect(new TextDecoder().decode(raw.slice(0, 6))).toBe("T247E1");
    await expect(decodeExportFile(raw, null)).rejects.toThrow(/encrypted/);
    const lines = (await decodeExportFile(raw, KEY)).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.title).sort()).toEqual(["Record 0", "Record 1", "Record 2"]);
    expect(lines[0].search).toBeUndefined();
    const users = JSON.parse((await decodeExportFile((await backups.get(manifest.tables.users.parts[0]))!.body as Uint8Array, KEY)).split("\n")[0]!);
    expect(users.oidc_subject).toBeUndefined();
    // A finished export does nothing more tonight.
    expect(await runExportStep(worker(), ws.id)).toBe(false);
  });

  it("reports backup health to admins", async () => {
    const h = await admin.get("/api/admin/backups");
    expect(h.json).toMatchObject({ configured: true, encrypted: true });
    expect(h.json.runs[0]).toMatchObject({ status: "succeeded", location: `exports/${ws.slug}/2026-10-07/` });
    expect(h.json.runs[0].rows).toBeGreaterThan(10);
  });

  it("keeps daily and monthly exports and prunes the rest", async () => {
    for (const d of ["2026-07-01", "2026-07-15", "2026-08-01", "2026-08-20", "2026-09-01", "2026-10-01", "2026-10-05", "2026-10-06"]) {
      await backups.put(`exports/${ws.slug}/${d}/manifest.json`, new Uint8Array([1]), "application/json");
    }
    const dropped = await pruneExports(worker(), ws.slug);
    expect(dropped.sort()).toEqual(["2026-07-01", "2026-07-15", "2026-08-01", "2026-08-20"]);
    const left = [...new Set((await backups.list(`exports/${ws.slug}/`)).map((k) => k.split("/")[2]))].sort();
    expect(left).toEqual(["2026-09-01", "2026-10-01", "2026-10-05", "2026-10-06", "2026-10-07"]);
  });

  it("alerts admins when an export fails", async () => {
    clock = new Date("2026-10-08T07:00:00Z");
    const broken = new MemoryBlobStore();
    broken.put = async () => {
      throw new Error("bucket unavailable");
    };
    const w = { ...worker(), backups: broken };
    expect(await runExportStep(w, ws.id)).toBe(false);
    const h = await admin.get("/api/admin/backups");
    expect(h.json.runs[0]).toMatchObject({ status: "failed", error: "bucket unavailable" });
    const n = await admin.get("/api/notifications");
    expect(n.json.notifications[0]).toMatchObject({ kind: "backup", title: "Nightly export failed: bucket unavailable" });
  });

  it("the cron sweep schedules nightly jobs, and the export timer runs", async () => {
    clock = new Date("2026-10-09T01:50:00Z");
    await sweep(worker());
    const jobs = await sql<{ kind: string; runAt: Date }[]>`select kind, run_at from scheduled_jobs where tenant_id = ${ws.id} and kind in ('export', 'purge_trash') order by kind`;
    expect(jobs.map((j) => [j.kind, j.runAt.toISOString()])).toEqual([
      ["export", "2026-10-09T02:00:00.000Z"],
      ["purge_trash", "2026-10-09T03:00:00.000Z"],
    ]);
    clock = new Date("2026-10-09T02:00:30Z");
    for (let i = 0; i < 20; i++) await runDueJobs(worker());
    expect(await backups.get(`exports/${ws.slug}/2026-10-09/manifest.json`)).not.toBeNull();
    const [next] = await sql<{ runAt: Date }[]>`select run_at from scheduled_jobs where tenant_id = ${ws.id} and kind = 'export'`;
    expect(next!.runAt.toISOString()).toBe("2026-10-10T02:00:00.000Z");
  });

  it("rebuild after restore re-arms timers and re-queues undelivered events", async () => {
    await withTenant(sql, ws.id, (tx) => tx`update outbox set delivered_at = null, attempts = 3 where id = (select max(id) from outbox)`);
    const r = await rebuildAfterRestore(worker());
    expect(r.tenants).toBeGreaterThan(0);
    expect(r.events).toBeGreaterThanOrEqual(1);
    const [signal] = await sql`select 1 from work_signals where tenant_id = ${ws.id}`;
    expect(signal).toBeTruthy();
  });
});
