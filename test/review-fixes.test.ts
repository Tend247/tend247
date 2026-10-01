// Regression tests for the Phase 1–2 security review findings.
import { describe, expect, it, beforeAll } from "vitest";
import { handleInboundEmail, senderAuthenticated } from "../src/worker/email/inbound.ts";
import { MemoryBlobStore } from "../src/worker/attachments/blobs.ts";
import { MemoryEmailSender } from "../src/worker/email/sender.ts";
import { purgeTrash, sendPendingEmails } from "../src/worker/jobs/runner.ts";
import { withTenant } from "../src/worker/db/client.ts";
import { appSql, makeApp, createWorkspace, addUser, Client, setupApProject, type TestWorkspace } from "./helpers.ts";

const sql = appSql();
const blobs = new MemoryBlobStore();
const { app, email, worker } = makeApp(sql, { blobs });

let ws: TestWorkspace;
let admin: Client;
let member: Client;
let memberId: string;
let outsider: Client;
let outsiderId: string;
let outsiderEmail: string;
let req: Client;
let projectId: string;
let recordTypeId: string;

beforeAll(async () => {
  ws = await createWorkspace(sql);
  admin = await new Client(app).signIn(ws.admin.email, ws.slug);
  const m = await addUser(sql, ws, "agent");
  const o = await addUser(sql, ws, "agent");
  [memberId, outsiderId, outsiderEmail] = [m.id, o.id, o.email];
  member = await new Client(app).signIn(m.email, ws.slug);
  outsider = await new Client(app).signIn(o.email, ws.slug);
  req = await new Client(app).signIn((await addUser(sql, ws, "requester")).email, ws.slug);
  ({ projectId, recordTypeId } = await setupApProject(admin, "SEC"));
  const team = (await admin.post("/api/admin/teams", { name: "Payroll", memberIds: [memberId] })).json.team;
  await admin.patch(`/api/admin/projects/${projectId}`, { restricted: true, defaultTeamId: team.id });
});

const newRecord = async (client = req) => (await client.post("/api/records", { recordTypeId, title: "Salary query", custom: { vendor: "Payroll" } })).json.record;

describe("inbound sender check", () => {
  const h = (v: string) => [{ key: "authentication-results", value: v }];
  it("is not fooled by text the sender controls", () => {
    // Envelope sender crafted to contain "dmarc=pass".
    expect(senderAuthenticated(h("mx.cloudflare.net; dmarc=fail header.from=victim.test; spf=pass smtp.mailfrom=dmarc=pass@evil.test"), "mx.cloudflare.net", "victim.test")).toBe(false);
    // Quoted local part that looks like the victim's domain.
    expect(senderAuthenticated(h('mx.cloudflare.net; spf=pass smtp.mailfrom="x@victim.test"@evil.test'), "mx.cloudflare.net", "victim.test")).toBe(false);
    // Comments are ignored.
    expect(senderAuthenticated(h("mx.cloudflare.net; dmarc=fail (dmarc=pass header.from=victim.test) header.from=victim.test"), "mx.cloudflare.net", "victim.test")).toBe(false);
    // DMARC must be for the From domain.
    expect(senderAuthenticated(h("mx.cloudflare.net; dmarc=pass header.from=evil.test"), "mx.cloudflare.net", "victim.test")).toBe(false);
    // Only the topmost header counts, and it must be ours.
    expect(senderAuthenticated([{ key: "authentication-results", value: "evil.test; dmarc=pass header.from=victim.test" }, ...h("mx.cloudflare.net; dmarc=pass header.from=victim.test")], "mx.cloudflare.net", "victim.test")).toBe(false);
    // Escaped quotes and parentheses inside quoted addresses cannot open new clauses.
    expect(senderAuthenticated(h('mx.cloudflare.net; dmarc=fail header.from=victim.test; spf=pass smtp.mailfrom="a\\";dmarc=pass header.from=victim.test;x=\\"b"@evil.test'), "mx.cloudflare.net", "victim.test")).toBe(false);
    expect(senderAuthenticated(h('mx.cloudflare.net; dmarc=fail header.from=victim.test; spf=pass (domain of "a);dmarc=pass header.from=victim.test;("@evil.test designates 1.2.3.4) smtp.mailfrom=x@evil.test'), "mx.cloudflare.net", "victim.test")).toBe(false);
    expect(senderAuthenticated(h("mx.cloudflare.net; dkim=pass header.d=mail.victim.test; spf=fail"), "mx.cloudflare.net", "victim.test")).toBe(true);
    expect(senderAuthenticated(h("mx.cloudflare.net 1; spf=pass smtp.mailfrom=bounce@victim.test"), "mx.cloudflare.net", "victim.test")).toBe(true);
  });
});

describe("inbound envelope sender", () => {
  it("refuses quoted or unusual envelope senders", async () => {
    const raw = ["Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=fernhollow.test", "From: <x@fernhollow.test>", "To: nobody@help.fernhollow.test", "Subject: s", "", "b", ""].join("\r\n");
    const r = await handleInboundEmail(worker(), { to: "nobody@help.fernhollow.test", from: '"a;dmarc=pass"@evil.test', raw });
    expect(r.outcome).toBe("unauthenticated");
  });
});

describe("restricted-project visibility in notifications", () => {
  it("refuses watchers who cannot see the record, and never notifies them", async () => {
    const rec = await newRecord();
    const r = await admin.post(`/api/records/${rec.key}/watchers`, { watching: true, userId: outsiderId });
    expect(r.status).toBe(422);
    // Even if someone was watching before access changed, internal notes do not reach them.
    await withTenant(sql, ws.id, (tx) => tx`insert into record_watchers (tenant_id, record_id, user_id) values (${ws.id}, ${rec.id}, ${outsiderId})`);
    await member.post(`/api/records/${rec.key}/comments`, { body: "INTERNAL SALARY 123", internal: true });
    const n = (await outsider.get("/api/notifications")).json.notifications;
    expect(n.some((x: { body: string }) => x.body.includes("SALARY"))).toBe(false);
    expect(email.sent.filter((m) => m.text.includes("INTERNAL SALARY")).map((m) => m.to)).not.toContain(outsiderEmail);
  });

  it("leaves out approvers who cannot see the record", async () => {
    await admin.put(`/api/admin/config/workflow/${recordTypeId}/draft`, {
      definition: {
        initial: "new",
        statuses: [{ key: "new", name: "New", category: "todo" }, { key: "ok", name: "OK", category: "done" }],
        transitions: [{ key: "ok", name: "Approve", from: ["new"], to: "ok", roles: ["admin", "agent", "requester"], approval: { mode: "any", approvers: [outsiderId, memberId] } }],
      },
    });
    expect((await admin.post(`/api/admin/config/workflow/${recordTypeId}/publish`, { statusMap: { in_progress: "new", waiting: "new", done: "ok" } })).status).toBe(200);
    const rec = await newRecord();
    const r = await req.post(`/api/records/${rec.key}/transitions`, { transition: "ok" });
    expect(r.json.approval.steps[0].approvers).toEqual([memberId]);
    expect((await outsider.get("/api/approvals")).json.approvals).toEqual([]);
    expect((await member.get("/api/approvals")).json.approvals.map((a: { recordKey: string }) => a.recordKey)).toEqual([rec.key]);
    await member.post(`/api/approvals/${r.json.approval.id}/decision`, { decision: "approve" });
    // The requester sees the decision but not who made it.
    const events = (await req.get(`/api/records/${rec.key}/events`)).json.events;
    for (const e of events.filter((x: { kind: string; data: { approvalId?: string } }) => x.kind === "approval_decided" || (x.kind === "transitioned" && x.data.approvalId))) {
      expect({ kind: e.kind, actorId: e.actorId, actorName: e.actorName }).toEqual({ kind: e.kind, actorId: null, actorName: null });
    }
  });
});

describe("attachments on internal notes", () => {
  it("stay internal even after their note is purged", async () => {
    const rec = await newRecord();
    const note = (await member.post(`/api/records/${rec.key}/comments`, { body: "payslip attached", internal: true })).json.comment;
    const up = await member.upload(`/api/records/${rec.key}/attachments?commentId=${note.id}`, new TextEncoder().encode("salary"), "salary.txt", "text/plain");
    await member.delete(`/api/comments/${note.id}`);
    expect((await admin.post(`/api/attachments/${up.json.attachment.id}/restore`)).status).toBe(409);
    await purgeTrash(worker(), ws.id, new Date(Date.now() + 31 * 86_400_000));
    // The note is gone; even if the file row survived it would stay internal.
    const [row] = await withTenant(sql, ws.id, (tx) => tx`select internal from attachments where id = ${up.json.attachment.id}`);
    if (row) expect(row.internal).toBe(true);
    expect((await req.raw(`/api/attachments/${up.json.attachment.id}`)).status).toBe(404);
  });

  it("requires a declared Content-Length for uploads", async () => {
    const rec = await newRecord();
    const res = await app.request(`http://localhost/api/records/${rec.key}/attachments`, {
      method: "POST",
      body: new Uint8Array([1, 2, 3]),
      headers: { "content-type": "application/octet-stream", "x-tend-upload": "1", cookie: req.cookie },
    });
    expect(res.status).toBe(400);
  });
});

describe("email queue", () => {
  it("backs off a failing address without holding up other mail", async () => {
    const rec = await newRecord();
    let calls = 0;
    const flaky = new MemoryEmailSender();
    const failing = { name: "flaky", canDeliver: true, send: async (m: { to: string }) => { calls++; if (m.to.startsWith("requester")) throw new Error("inactive recipient"); return flaky.send(m as never); } };
    await withTenant(sql, ws.id, async (tx) => {
      await tx`update notifications set email_payload = null where email_payload is not null`;
      await tx`
        insert into notifications (tenant_id, user_id, kind, record_id, title, email_wanted, email_payload)
        select ${ws.id}, u.id, 'comment', ${rec.id}, 't', true, ${tx.json({ subject: "Hello\r\nBcc: attacker@evil.test", text: "x" })}
        from users u where u.role in ('requester', 'admin')`;
    });
    const w = { ...worker(), email: failing as never };
    await sendPendingEmails(w, ws.id);
    expect(flaky.sent.length).toBeGreaterThan(0);
    expect(flaky.sent.every((m) => !m.subject.includes("\n"))).toBe(true);
    const before = calls;
    await sendPendingEmails(w, ws.id); // failed ones wait for their backoff
    expect(calls).toBe(before);
    const rows = await withTenant(sql, ws.id, (tx) => tx`select email_attempts from notifications where email_attempts > 0`);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("strips line breaks from record titles", async () => {
    const r = await req.post("/api/records", { recordTypeId, title: "Hello\r\nBcc: attacker@evil.test", custom: { vendor: "V" } });
    expect(r.json.record.title).toBe("Hello Bcc: attacker@evil.test");
  });
});

describe("configuration guards", () => {
  it("refuses webhook hosts that only look public", async () => {
    for (const url of ["https://localhost./x", "https://intranet/x", "https://printer.local/x"]) {
      const r = await admin.post("/api/admin/automation", { name: "x", trigger: "record.created", actions: [{ type: "webhook", url }] });
      expect({ url, status: r.status }).toEqual({ url, status: 422 });
    }
  });

  it("refuses SLA targets a calendar cannot reach", async () => {
    const cal = await admin.post("/api/admin/calendars", { name: "Almost closed", timezone: "UTC", hours: { mon: [["09:00", "09:01"]] } });
    const r = await admin.put(`/api/admin/config/sla/${projectId}/draft`, {
      definition: { policies: [{ name: "x", resolutionMinutes: 525600, calendarId: cal.json.calendar.id }] },
    });
    expect(r.status).toBe(422);
    expect(r.json.error.details.issues[0].field).toBe("policies.0.calendarId");
  });
});
