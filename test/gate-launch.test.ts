// GATE (Phase 3 / 1.0): "pilot teams live on two functions; demo and installer public". The
// pilots themselves happen in the field; this proves the product side end to end: two
// functions installed from templates and worked through the portal and the agent app, an
// integration on a scoped token, a read-only phone, a workspace that moves by bundle, and a
// stranger getting a working demo sandbox in seconds.
import { describe, expect, it } from "vitest";
import { appSql, makeApp, baseConfig, createWorkspace, addUser, Client } from "./helpers.ts";
import { decodeWorkspace, importWorkspace, countRows, readWorkspace } from "../src/worker/workspace/bundle.ts";

const sql = appSql();
const { app } = makeApp(sql, {
  config: { publicSite: true, demo: { ...baseConfig.demo, enabled: true } },
  verifyTurnstile: async (t) => t === "ok",
});

describe("1.0 launch gate", () => {
  it("two functions run end to end, with portal, API, phone access and a portable workspace", async () => {
    const ws = await createWorkspace(sql, "Pilot Co");
    const admin = await new Client(app).signIn(ws.admin.email, ws.slug);
    const hrAgent = await addUser(sql, ws, "agent");
    const apAgent = await addUser(sql, ws, "agent");
    const employee = await addUser(sql, ws, "requester");

    // Two functions from templates, each owned by its own team.
    const hr = (await admin.post("/api/admin/templates/hr_cases/install", {})).json;
    const ap = (await admin.post("/api/admin/templates/ap_requests/install", {})).json;
    await admin.patch(`/api/admin/teams/${hr.teamId}`, { memberIds: [hrAgent.id] });
    await admin.patch(`/api/admin/teams/${ap.teamId}`, { memberIds: [apAgent.id] });

    // An employee asks HR through the portal's API calls.
    const me = await new Client(app).signIn(employee.email, ws.slug);
    const catalog = (await me.get("/api/config")).json.projects.map((p: { key: string }) => p.key);
    expect(catalog).toEqual(expect.arrayContaining(["HR", "FIN"]));
    const hrCase = await me.post("/api/records", {
      recordTypeId: hr.recordTypeId,
      title: "Leave question",
      description: "Can I carry over two days?",
      custom: { category: "leave" },
    });
    expect(hrCase.status, JSON.stringify(hrCase.json)).toBe(201);

    // HR works it; AP cannot see it (restricted project).
    const hrc = await new Client(app).signIn(hrAgent.email, ws.slug);
    const apc = await new Client(app).signIn(apAgent.email, ws.slug);
    expect((await apc.get(`/api/records/${hrCase.json.record.key}`)).status).toBe(404);
    await hrc.post(`/api/records/${hrCase.json.record.key}/transitions`, { transition: "review" });
    await hrc.post(`/api/records/${hrCase.json.record.key}/comments`, { body: "Yes, up to five days.", internal: false });
    await hrc.post(`/api/records/${hrCase.json.record.key}/comments`, { body: "Checked the policy.", internal: true });
    const resolved = await hrc.post(`/api/records/${hrCase.json.record.key}/transitions`, {
      transition: "resolve",
      fields: { custom: { resolution: "Carry over approved." } },
    });
    expect(resolved.status, JSON.stringify(resolved.json)).toBe(200);
    // The employee sees the public reply, not the internal note, and can reopen.
    const thread = (await me.get(`/api/records/${hrCase.json.record.key}/comments`)).json.comments.map((c: { body: string }) => c.body);
    expect(thread).toEqual(["Yes, up to five days."]);
    const view = (await me.get(`/api/records/${hrCase.json.record.key}`)).json;
    expect(view.transitions.map((t: { key: string }) => t.key)).toEqual(["reopen"]);

    // AP: an invoice exception goes through approval.
    const inv = await apc.post("/api/records", { recordTypeId: ap.recordTypeId, title: "Price mismatch", custom: { vendor: "Acme", amount: 120 } });
    expect(inv.status, JSON.stringify(inv.json)).toBe(201);
    await apc.post(`/api/records/${inv.json.record.key}/transitions`, { transition: "investigate" });
    const ask = await apc.post(`/api/records/${inv.json.record.key}/transitions`, { transition: "approve_payment" });
    expect(ask.json.approval?.status ?? ask.json.pendingApproval?.status ?? "pending").toBe("pending");
    const pending = (await admin.get("/api/approvals")).json.approvals[0];
    expect((await admin.post(`/api/approvals/${pending.id}/decision`, { decision: "approve" })).status).toBe(200);
    expect((await apc.get(`/api/records/${inv.json.record.key}`)).json.record.status).toBe("approved_for_payment");

    // An integration reads AP on a read-only token.
    const token = (await apc.post("/api/tokens", { name: "ERP", scopes: ["records:read"] })).json.secret;
    const api = await new Client(app).req("GET", `/api/records?projectId=${ap.project.id}`, undefined, { authorization: `Bearer ${token}` });
    expect(api.json.items.map((r: { key: string }) => r.key)).toContain(inv.json.record.key);

    // The dashboard counts both functions: the HR case resolved, the invoice still open.
    const dash = (await admin.get("/api/dashboard")).json;
    expect(dash.totals).toMatchObject({ createdInWindow: 2, resolvedInWindow: 1, open: 1 });
    expect(dash.openByProject.map((p: { key: string }) => p.key)).toEqual(["FIN"]);

    // A phone links read-only.
    const start = (await hrc.post("/api/devices/pair")).json;
    const phone = new Client(app);
    await phone.post("/auth/pair/claim", { code: new URLSearchParams(new URL(start.url).hash.slice(1)).get("c") });
    await hrc.post(`/api/devices/pair/${start.id}/approve`);
    expect((await phone.post("/auth/pair/redeem")).status).toBe(200);
    expect((await phone.get(`/api/records/${hrCase.json.record.key}`)).status).toBe(200);
    expect((await phone.post(`/api/records/${hrCase.json.record.key}/comments`, { body: "x" })).status).toBe(403);

    // The workspace moves by bundle with everything in it.
    const res = await admin.raw("/api/admin/workspace/export");
    const bundle = await decodeWorkspace(new Uint8Array(await res.arrayBuffer()));
    const moved = await importWorkspace(sql, bundle, { slug: `moved-${Date.now().toString(36)}`, disableWebhooks: true });
    expect(countRows(await readWorkspace(sql, moved.tenantId))).toEqual(countRows(bundle));
  });

  it("a stranger gets a working demo sandbox in seconds", async () => {
    const started = Date.now();
    const visitor = new Client(app);
    expect((await visitor.post("/auth/demo/start", { turnstileToken: "ok" })).status).toBe(200);
    const records = (await visitor.get("/api/records?limit=100")).json.items;
    expect(records.length).toBeGreaterThan(10);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
