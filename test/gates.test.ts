// GATES (Phases 1 and 2), as one end-to-end scenario at Fernhollow Foods:
//  Phase 1: one internal team runs a live queue end to end (intake, routing, work, resolve).
//  Phase 2: SLA, approval and email flows hold together.
import { describe, expect, it } from "vitest";
import { MemoryBlobStore } from "../src/worker/attachments/blobs.ts";
import { handleInboundEmail } from "../src/worker/email/inbound.ts";
import { runDueJobs } from "../src/worker/jobs/runner.ts";
import { appSql, makeApp, createWorkspace, addUser, Client, unique } from "./helpers.ts";

const sql = appSql();
let clock = new Date();
const { app, email, worker } = makeApp(sql, { blobs: new MemoryBlobStore(), now: () => clock });
const AUTH = "Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=fernhollow.test";

const mail = (from: string, to: string, subject: string, text: string) =>
  [AUTH, `From: <${from}>`, `To: ${to}`, `Subject: ${subject}`, `Message-ID: <${unique("g")}@fernhollow.test>`, "Content-Type: text/plain", "", text, ""].join("\r\n");

describe("Phase 1 and 2 gates", () => {
  it("the IT service desk runs a live queue with SLAs, approvals and email", async () => {
    // --- Admin sets up the queue: project, type, fields, workflow with approval, team, SLA, inbound address.
    const ws = await createWorkspace(sql, "Fernhollow Foods");
    const admin = await new Client(app).signIn(ws.admin.email, ws.slug);
    const sam = await addUser(sql, ws, "agent", `${unique("sam")}@fernhollow.test`);
    const lee = await addUser(sql, ws, "agent", `${unique("lee")}@fernhollow.test`);
    const dana = await addUser(sql, ws, "agent", `${unique("dana")}@fernhollow.test`); // IT manager, approves purchases
    const jo = await addUser(sql, ws, "requester", `${unique("jo")}@fernhollow.test`);

    const project = (await admin.post("/api/admin/projects", { key: "ITSD", name: "IT Service Desk" })).json.project;
    const type = (await admin.post(`/api/admin/projects/${project.id}/record-types`, { key: "request", name: "IT request" })).json.recordType;
    await admin.post(`/api/admin/record-types/${type.id}/fields`, {
      key: "category",
      label: "Category",
      type: "select",
      options: { choices: [{ value: "hardware", label: "Hardware" }, { value: "access", label: "Access" }] },
    });
    await admin.post(`/api/admin/record-types/${type.id}/fields`, { key: "resolution", label: "Resolution", type: "long_text" });
    const team = (await admin.post("/api/admin/teams", { name: "Service desk", memberIds: [sam.id, lee.id] })).json.team;
    await admin.put(`/api/admin/config/workflow/${type.id}/draft`, {
      definition: {
        initial: "new",
        statuses: [
          { key: "new", name: "New", category: "todo" },
          { key: "in_progress", name: "In progress", category: "in_progress" },
          { key: "awaiting_purchase", name: "Awaiting purchase", category: "in_progress" },
          { key: "waiting_on_requester", name: "Waiting on requester", category: "in_progress" },
          { key: "resolved", name: "Resolved", category: "done" },
        ],
        transitions: [
          { key: "start", name: "Start", from: ["new"], to: "in_progress" },
          { key: "ask", name: "Ask requester", from: ["in_progress"], to: "waiting_on_requester" },
          { key: "resume", name: "Resume", from: ["waiting_on_requester", "awaiting_purchase"], to: "in_progress" },
          { key: "buy", name: "Request purchase", from: ["in_progress"], to: "awaiting_purchase", approval: { mode: "any", approvers: [dana.id] } },
          { key: "resolve", name: "Resolve", from: ["in_progress", "awaiting_purchase"], to: "resolved", requiredFields: ["resolution"] },
        ],
      },
    });
    expect((await admin.post(`/api/admin/config/workflow/${type.id}/publish`, { statusMap: { waiting: "waiting_on_requester", done: "resolved" } })).status).toBe(200);
    await admin.put(`/api/admin/config/sla/${project.id}/draft`, {
      definition: { policies: [{ name: "Standard", firstResponseMinutes: 60, resolutionMinutes: 480 }], pauseStatuses: ["waiting_on_requester", "awaiting_purchase"] },
    });
    expect((await admin.post(`/api/admin/config/sla/${project.id}/publish`, {})).status).toBe(200);
    const alias = unique("it").toLowerCase().replace(/[^a-z0-9-]/g, "");
    const p = await admin.patch(`/api/admin/projects/${project.id}`, { defaultTeamId: team.id, assignment: "round_robin", inbound: { address: alias, recordTypeId: type.id } });
    expect(p.status).toBe(200);

    // --- Jo emails the desk. A record is created, routed to the team round-robin, clocks start.
    clock = new Date();
    const intake = await handleInboundEmail(worker(), {
      to: `${alias}@help.fernhollow.test`,
      raw: mail(jo.email, `${alias}@help.fernhollow.test`, "Laptop battery swelling", "My laptop battery is bulging. Can I get a replacement?"),
    });
    expect(intake.outcome).toBe("record_created");
    const key = intake.key!;
    const samC = await new Client(app).signIn(sam.email, ws.slug);
    let rec = (await samC.get(`/api/records/${key}`)).json;
    expect(rec.record).toMatchObject({ status: "new", teamId: team.id, via: "email" });
    const assignee = rec.record.assigneeId as string;
    expect([sam.id, lee.id]).toContain(assignee);
    expect(rec.sla.map((c: { metric: string; status: string }) => [c.metric, c.status])).toEqual([
      ["first_response", "running"],
      ["resolution", "running"],
    ]);
    const confirmation = email.sent.find((m) => m.to === jo.email && m.subject === `[${key}] Laptop battery swelling`)!;
    expect(confirmation.replyTo).toMatch(/^reply\+/);
    const worker1 = assignee === sam.id ? samC : await new Client(app).signIn(lee.email, ws.slug);

    // --- The assignee sees it in their queue, starts work and replies: first response met.
    const queue = await worker1.get("/api/records?teamId=mine&assigneeId=me&statusCategory=todo");
    expect(queue.json.items.map((r: { key: string }) => r.key)).toContain(key);
    await worker1.post(`/api/records/${key}/transitions`, { transition: "start" });
    await worker1.post(`/api/records/${key}/comments`, { body: "Please stop using it. Which model is it?" });
    await worker1.post(`/api/records/${key}/transitions`, { transition: "ask" });
    rec = (await worker1.get(`/api/records/${key}`)).json;
    expect(rec.sla.map((c: { status: string }) => c.status)).toEqual(["met", "paused"]);

    // --- Jo answers by email; the reply lands as a comment. Work resumes.
    const ask = email.sent.filter((m) => m.to === jo.email && m.subject.startsWith(`[${key}]`) && m.text.includes("Which model")).at(-1)!;
    const reply = await handleInboundEmail(worker(), { to: ask.replyTo!, raw: mail(jo.email, ask.replyTo!, `Re: ${ask.subject}`, "ThinkPad T14 Gen 3.\n\nOn Tue IT wrote:\n> Which model is it?") });
    expect(reply.outcome).toBe("comment_added");
    await worker1.post(`/api/records/${key}/transitions`, { transition: "resume" });

    // --- A replacement battery needs the manager's approval, decided from the email link.
    const buy = await worker1.post(`/api/records/${key}/transitions`, { transition: "buy" });
    expect(buy.json.approval.status).toBe("pending");
    const approvalMail = email.sent.filter((m) => m.to === dana.email && m.text.includes("/auth/approval#")).at(-1)!;
    const token = /\/auth\/approval#(\S+)/.exec(approvalMail.text)![1]!;
    expect((await new Client(app).post("/auth/approval/decide", { token, decision: "approve" })).json.status).toBe("approved");
    rec = (await worker1.get(`/api/records/${key}`)).json;
    expect(rec.record.status).toBe("awaiting_purchase");
    expect(rec.sla[1].status).toBe("paused");

    // --- Time passes while paused: no breach. Then the battery arrives; resolve needs a resolution.
    clock = new Date(Date.now() + 10 * 3600_000);
    await runDueJobs(worker());
    rec = (await worker1.get(`/api/records/${key}`)).json;
    expect(rec.sla[1].breachedAt).toBeNull();
    expect((await worker1.post(`/api/records/${key}/transitions`, { transition: "resolve" })).status).toBe(422);
    const done = await worker1.post(`/api/records/${key}/transitions`, { transition: "resolve", fields: { custom: { resolution: "Battery replaced; old one recycled." } } });
    expect(done.json.record).toMatchObject({ status: "resolved", statusCategory: "done" });
    rec = (await worker1.get(`/api/records/${key}`)).json;
    expect(rec.sla.map((c: { status: string; breachedAt: string | null }) => [c.status, c.breachedAt])).toEqual([
      ["met", null],
      ["met", null],
    ]);

    // --- Jo is told by email and sees the history that matters to her, not internal detail.
    expect(email.sent.some((m) => m.to === jo.email && m.text.startsWith(`${key} is now Resolved`))).toBe(true);
    const joC = await new Client(app).signIn(jo.email, ws.slug);
    const history = (await joC.get(`/api/records/${key}/events`)).json.events.map((e: { kind: string }) => e.kind);
    expect(history).toEqual(expect.arrayContaining(["created", "transitioned", "approval_requested", "approval_decided"]));
    expect(history).not.toContain("updated");
    const board = (await worker1.get(`/api/board?recordTypeId=${type.id}`)).json.columns;
    expect(board.find((c: { key: string }) => c.key === "resolved").records.map((r: { key: string }) => r.key)).toContain(key);
  });
});
