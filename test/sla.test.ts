// Phase 2: business-hours math, SLA clocks kept in step with record changes, and the timers
// that raise warning and breach events.
import { describe, expect, it, beforeAll } from "vitest";
import { addBusinessMinutes, businessMinutesBetween, nextLocalTime, type Calendar } from "../src/worker/sla/calendar.ts";
import { withTenant } from "../src/worker/db/client.ts";
import { runDueJobs } from "../src/worker/jobs/runner.ts";
import { appSql, makeApp, createWorkspace, addUser, Client, setupApProject, type TestWorkspace } from "./helpers.ts";

const NY: Calendar = {
  timezone: "America/New_York",
  hours: { mon: [["09:00", "17:00"]], tue: [["09:00", "17:00"]], wed: [["09:00", "17:00"]], thu: [["09:00", "17:00"]], fri: [["09:00", "17:00"]] },
  holidays: ["2026-12-25"],
};

describe("business-hours calendar", () => {
  it("adds working minutes within and across days", () => {
    // Mon 2026-10-05 10:00 New York (EDT, UTC-4) = 14:00 UTC.
    expect(addBusinessMinutes(new Date("2026-10-05T14:00:00Z"), 60, NY).toISOString()).toBe("2026-10-05T15:00:00.000Z");
    // 8h from Mon 10:00 → Tue 10:00.
    expect(addBusinessMinutes(new Date("2026-10-05T14:00:00Z"), 480, NY).toISOString()).toBe("2026-10-06T14:00:00.000Z");
    // Fri 16:00 + 2h → Mon 10:00.
    expect(addBusinessMinutes(new Date("2026-10-09T20:00:00Z"), 120, NY).toISOString()).toBe("2026-10-12T14:00:00.000Z");
    // Starting on a Saturday counts from Monday 09:00.
    expect(addBusinessMinutes(new Date("2026-10-10T15:00:00Z"), 30, NY).toISOString()).toBe("2026-10-12T13:30:00.000Z");
  });

  it("skips holidays and handles the switch from daylight time", () => {
    // Thu 2026-12-24 16:00 EST + 2h → Fri 25th is a holiday → Mon 28th 10:00 EST (15:00 UTC).
    expect(addBusinessMinutes(new Date("2026-12-24T21:00:00Z"), 120, NY).toISOString()).toBe("2026-12-28T15:00:00.000Z");
    // Fri 2026-10-30 16:00 EDT + 2h → Mon Nov 2 10:00 EST (after DST ended) = 15:00 UTC.
    expect(addBusinessMinutes(new Date("2026-10-30T20:00:00Z"), 120, NY).toISOString()).toBe("2026-11-02T15:00:00.000Z");
  });

  it("counts working minutes between two instants", () => {
    expect(businessMinutesBetween(new Date("2026-10-09T20:00:00Z"), new Date("2026-10-12T14:00:00Z"), NY)).toBe(120);
    expect(businessMinutesBetween(new Date("2026-10-10T00:00:00Z"), new Date("2026-10-11T23:00:00Z"), NY)).toBe(0);
    expect(businessMinutesBetween(new Date("2026-10-05T14:00:00Z"), new Date("2026-10-05T15:30:00Z"), null)).toBe(90);
  });

  it("finds the next local wall-clock time", () => {
    // 05:00 UTC is 01:00 in New York, so 02:00 local is later the same day.
    expect(nextLocalTime(new Date("2026-10-05T05:00:00Z"), "America/New_York", 2).toISOString()).toBe("2026-10-05T06:00:00.000Z");
    expect(nextLocalTime(new Date("2026-10-05T07:00:00Z"), "America/New_York", 2).toISOString()).toBe("2026-10-06T06:00:00.000Z");
    expect(nextLocalTime(new Date("2026-10-05T05:00:00Z"), "UTC", 2).toISOString()).toBe("2026-10-06T02:00:00.000Z");
  });
});

const sql = appSql();
let clock = new Date();
const { app, worker } = makeApp(sql, { now: () => clock });

let ws: TestWorkspace;
let admin: Client;
let agent: Client;
let agentId: string;
let req: Client;
let projectId: string;
let recordTypeId: string;

beforeAll(async () => {
  ws = await createWorkspace(sql);
  admin = await new Client(app).signIn(ws.admin.email, ws.slug);
  const a = await addUser(sql, ws, "agent");
  agentId = a.id;
  agent = await new Client(app).signIn(a.email, ws.slug);
  req = await new Client(app).signIn((await addUser(sql, ws, "requester")).email, ws.slug);
  ({ projectId, recordTypeId } = await setupApProject(admin, "SLA"));
});

const clocksOf = async (key: string) => (await agent.get(`/api/records/${key}`)).json.sla as any[];

describe("SLA policies and clocks", () => {
  it("validates policies and their calendars", async () => {
    const noTarget = await admin.put(`/api/admin/config/sla/${projectId}/draft`, { definition: { policies: [{ name: "none" }] } });
    expect(noTarget.json.error.details.issues.map((i: { field: string }) => i.field)).toEqual(["policies.0"]);
    const badCal = await admin.put(`/api/admin/config/sla/${projectId}/draft`, {
      definition: { policies: [{ name: "x", calendarId: "00000000-0000-4000-8000-000000000000", firstResponseMinutes: 5 }] },
    });
    expect(badCal.status).toBe(422);
    expect(badCal.json.error.details.issues.map((i: { field: string }) => i.field)).toEqual(["policies.0.calendarId"]);
    expect((await admin.post("/api/admin/calendars", { name: "Bad", timezone: "Mars/Olympus", hours: { mon: [["09:00", "17:00"]] } })).status).toBe(422);
    const cal = await admin.post("/api/admin/calendars", { name: "NY office", timezone: "America/New_York", hours: NY.hours, holidays: NY.holidays });
    expect(cal.status).toBe(201);
  });

  it("starts first-response and resolution clocks from the first matching policy", async () => {
    const def = {
      policies: [
        { name: "Urgent", match: { priorities: ["urgent"] }, firstResponseMinutes: 30, resolutionMinutes: 240 },
        { name: "Standard", firstResponseMinutes: 480, resolutionMinutes: 2400 },
      ],
      pauseStatuses: ["waiting"],
    };
    expect((await admin.put(`/api/admin/config/sla/${projectId}/draft`, { definition: def })).status).toBe(200);
    expect((await admin.post(`/api/admin/config/sla/${projectId}/publish`, {})).status).toBe(200);

    const rec = (await agent.post("/api/records", { recordTypeId, title: "Payment run failed", priority: "urgent", custom: { vendor: "Bank" } })).json.record;
    const clocks = await clocksOf(rec.key);
    expect(clocks.map((c) => [c.metric, c.policyName, c.targetMinutes, c.status])).toEqual([
      ["first_response", "Urgent", 30, "running"],
      ["resolution", "Urgent", 240, "running"],
    ]);
    const due = new Date(clocks[0].dueAt).getTime() - new Date(rec.createdAt).getTime();
    expect(Math.round(due / 60_000)).toBe(30);
  });

  it("re-targets on priority change, pauses on waiting, and stops when met", async () => {
    const rec = (await req.post("/api/records", { recordTypeId, title: "Duplicate invoice", custom: { vendor: "Acme" } })).json.record;
    expect((await clocksOf(rec.key))[0].policyName).toBe("Standard");
    const up = await agent.patch(`/api/records/${rec.key}`, { version: rec.version, priority: "urgent" });
    expect((await clocksOf(rec.key))[0]).toMatchObject({ policyName: "Urgent", targetMinutes: 30 });

    await agent.post(`/api/records/${rec.key}/transitions`, { transition: "start", version: up.json.record.version });
    await agent.post(`/api/records/${rec.key}/transitions`, { transition: "wait" });
    let clocks = await clocksOf(rec.key);
    expect(clocks.map((c) => c.status)).toEqual(["paused", "paused"]);
    expect(clocks[1].dueAt).toBeNull();

    await agent.post(`/api/records/${rec.key}/transitions`, { transition: "resume" });
    await agent.post(`/api/records/${rec.key}/comments`, { body: "On it" });
    clocks = await clocksOf(rec.key);
    expect(clocks.map((c) => c.status)).toEqual(["met", "running"]);
    await agent.post(`/api/records/${rec.key}/transitions`, { transition: "resolve" });
    clocks = await clocksOf(rec.key);
    expect(clocks.map((c) => c.status)).toEqual(["met", "met"]);
    const [job] = await sql`select count(*)::int as n from scheduled_jobs where kind = 'sla' and ref_id = ${clocks[1].id}`;
    expect(job!.n).toBe(0); // met clocks have no timer
  });

  it("raises a warning, then a breach, and notifies the assignee", async () => {
    clock = new Date();
    const rec = (await agent.post("/api/records", { recordTypeId, title: "Wire stuck", priority: "urgent", assigneeId: agentId, custom: { vendor: "Bank" } })).json.record;
    const fr = (await clocksOf(rec.key))[0];
    // 80% of 30 minutes: the warning is due at 24 minutes.
    clock = new Date(new Date(fr.warnAt).getTime() + 1000);
    await runDueJobs(worker());
    expect((await clocksOf(rec.key))[0].warnedAt).not.toBeNull();
    clock = new Date(new Date(fr.dueAt).getTime() + 1000);
    await runDueJobs(worker());
    const after = (await clocksOf(rec.key))[0];
    expect(after.breachedAt).not.toBeNull();
    expect(after.status).toBe("running"); // a breached clock keeps running until met
    const n = await agent.get("/api/notifications");
    const titles = n.json.notifications.filter((x: { kind: string; recordKey: string }) => x.kind === "sla" && x.recordKey === rec.key).map((x: { title: string }) => x.title);
    expect(titles).toEqual([`${rec.key} breached its first response target`, expect.stringMatching(new RegExp(`^${rec.key} first response is due`))]);
    expect((await agent.get("/api/records?sla=breached")).json.items.map((r: { key: string }) => r.key)).toContain(rec.key);
  });

  it("deleted records' timers do nothing", async () => {
    clock = new Date();
    const rec = (await agent.post("/api/records", { recordTypeId, title: "x", priority: "urgent", custom: { vendor: "V" } })).json.record;
    await agent.delete(`/api/records/${rec.key}`);
    clock = new Date(Date.now() + 3 * 3600_000);
    await runDueJobs(worker());
    const [row] = await withTenant(sql, ws.id, (tx) => tx`select count(*)::int as n from sla_clocks where record_id = ${rec.id} and breached_at is not null`);
    expect(row!.n).toBe(0);
  });

  it("requesters see clocks on their own records but cannot edit SLA policies", async () => {
    clock = new Date();
    const rec = (await req.post("/api/records", { recordTypeId, title: "Where is my refund?", custom: { vendor: "Me" } })).json.record;
    expect((await req.get(`/api/records/${rec.key}`)).json.sla.length).toBe(2);
    expect((await req.put(`/api/admin/config/sla/${projectId}/draft`, { definition: { policies: [] } })).status).toBe(403);
  });
});
