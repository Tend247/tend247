// GATE (Phase 0): configuration is data. Adding fields, choices and record types changes
// rows only — the database schema stays byte-for-byte the same.
import { describe, expect, it } from "vitest";
import { appSql, ownerSql, makeApp, createWorkspace, Client } from "./helpers.ts";

const sql = appSql();
const owner = ownerSql();
const { app } = makeApp(sql);

async function schemaFingerprint(): Promise<string> {
  const cols = await owner<{ t: string }[]>`
    select table_name || '.' || column_name || ':' || data_type as t
    from information_schema.columns where table_schema = 'public' order by 1`;
  const idx = await owner<{ t: string }[]>`select indexdef as t from pg_indexes where schemaname = 'public' order by 1`;
  const mig = await owner<{ t: string }[]>`select name as t from schema_migrations order by 1`;
  return JSON.stringify([cols, idx, mig].map((rows) => rows.map((r) => r.t)));
}

describe("adding configuration needs no migration", () => {
  it("adds a record type and fields, stores and filters values, and leaves the schema untouched", async () => {
    const before = await schemaFingerprint();
    const ws = await createWorkspace(sql);
    const admin = await new Client(app).signIn(ws.admin.email, ws.slug);

    const p = await admin.post("/api/admin/projects", { key: "HR", name: "HR Cases" });
    const rt = await admin.post(`/api/admin/projects/${p.json.project.id}/record-types`, {
      key: "shift_swap",
      name: "Shift swap",
    });
    const rtId = rt.json.recordType.id;
    const site = await admin.post(`/api/admin/record-types/${rtId}/fields`, {
      key: "plant_site",
      label: "Plant site",
      type: "select",
      options: { choices: [{ value: "bottling", label: "Bottling line" }] },
    });
    expect(site.status).toBe(201);
    const hours = await admin.post(`/api/admin/record-types/${rtId}/fields`, {
      key: "hours_requested",
      label: "Hours requested",
      type: "number",
      options: { min: 0, max: 24 },
    });
    expect(hours.status).toBe(201);

    const rec = await admin.post("/api/records", {
      recordTypeId: rtId,
      title: "Swap Saturday shift",
      custom: { plant_site: "bottling", hours_requested: 8 },
    });
    expect(rec.status).toBe(201);
    expect(rec.json.record.key).toBe("HR-1");
    expect(rec.json.record.custom).toEqual({ plant_site: "bottling", hours_requested: 8 });

    // Add a choice later and use it.
    const updated = await admin.patch(`/api/admin/fields/${site.json.field.id}`, {
      options: {
        choices: [
          { value: "bottling", label: "Bottling line" },
          { value: "sauce", label: "Sauce line" },
        ],
      },
    });
    expect(updated.status).toBe(200);
    const rec2 = await admin.post("/api/records", {
      recordTypeId: rtId,
      title: "Swap Sunday shift",
      custom: { plant_site: "sauce", hours_requested: 4 },
    });
    expect(rec2.status).toBe(201);

    const filtered = await admin.get(`/api/records?custom=${encodeURIComponent(JSON.stringify({ plant_site: "sauce" }))}`);
    expect(filtered.json.items.map((r: { key: string }) => r.key)).toEqual(["HR-2"]);

    expect(await schemaFingerprint()).toBe(before);
  });
});
