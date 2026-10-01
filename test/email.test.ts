// Phase 2: outbound notification email (threaded reply-to, preferences) and inbound email
// (queue addresses create records, replies become comments, sender checks, dedupe).
import { describe, expect, it, beforeAll } from "vitest";
import { handleInboundEmail } from "../src/worker/email/inbound.ts";
import { senderAuthenticated, stripQuoted } from "../src/worker/email/inbound.ts";
import { MemoryBlobStore } from "../src/worker/attachments/blobs.ts";
import { PostmarkEmailSender, ResendEmailSender } from "../src/worker/email/sender.ts";
import { appSql, makeApp, createWorkspace, addUser, Client, setupApProject, unique, type TestWorkspace } from "./helpers.ts";

const sql = appSql();
const blobs = new MemoryBlobStore();
const { app, email, worker } = makeApp(sql, { blobs });

let ws: TestWorkspace;
let admin: Client;
let agent: Client;
let agentEmail: string;
let req: Client;
let reqEmail: string;
let recordTypeId: string;
let projectId: string;
let alias: string;

const PASS = "mx.cloudflare.net; dkim=pass header.d=fernhollow.test; spf=pass smtp.mailfrom=fernhollow.test; dmarc=pass header.from=fernhollow.test";

function mime(o: { from: string; to: string; subject: string; text: string; messageId?: string; auth?: string; extra?: string; attachment?: { name: string; data: string } }) {
  const boundary = "b1";
  const head = [
    ...(o.auth === "" ? [] : [`Authentication-Results: ${o.auth ?? PASS}`]),
    `From: Sender <${o.from}>`,
    `To: ${o.to}`,
    `Subject: ${o.subject}`,
    `Message-ID: ${o.messageId ?? `<${unique("m")}@fernhollow.test>`}`,
    ...(o.extra ? [o.extra] : []),
    "MIME-Version: 1.0",
  ];
  if (!o.attachment) return [...head, "Content-Type: text/plain; charset=utf-8", "", o.text, ""].join("\r\n");
  return [
    ...head,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    o.text,
    `--${boundary}`,
    `Content-Type: text/csv; name="${o.attachment.name}"`,
    `Content-Disposition: attachment; filename="${o.attachment.name}"`,
    "Content-Transfer-Encoding: base64",
    "",
    btoa(o.attachment.data),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

beforeAll(async () => {
  ws = await createWorkspace(sql);
  admin = await new Client(app).signIn(ws.admin.email, ws.slug);
  const a = await addUser(sql, ws, "agent", `${unique("agent")}@fernhollow.test`);
  agentEmail = a.email;
  agent = await new Client(app).signIn(a.email, ws.slug);
  const r = await addUser(sql, ws, "requester", `${unique("req")}@fernhollow.test`);
  reqEmail = r.email;
  req = await new Client(app).signIn(r.email, ws.slug);
  ({ projectId, recordTypeId } = await setupApProject(admin, "MAIL"));
  // The queue's record type needs no required field the email cannot supply.
  const fields = (await admin.get(`/api/admin/record-types/${recordTypeId}/fields`)).json.fields;
  await admin.patch(`/api/admin/fields/${fields.find((f: { key: string }) => f.key === "vendor").id}`, { required: false });
  alias = unique("ap").toLowerCase().replace(/[^a-z0-9-]/g, "");
  const p = await admin.patch(`/api/admin/projects/${projectId}`, { inbound: { address: alias, recordTypeId } });
  expect(p.status).toBe(200);
  expect(p.json.project.inbound).toEqual({ address: alias, recordTypeId });
});

describe("sender checks and parsing", () => {
  it("trusts only our own server's Authentication-Results, aligned with From", () => {
    const h = (v: string) => [{ key: "authentication-results", value: v }];
    expect(senderAuthenticated(h(PASS), "mx.cloudflare.net", "fernhollow.test")).toBe(true);
    expect(senderAuthenticated(h("mx.cloudflare.net; dmarc=fail; spf=pass smtp.mailfrom=evil.test"), "mx.cloudflare.net", "fernhollow.test")).toBe(false);
    expect(senderAuthenticated(h("mx.cloudflare.net; dmarc=none; dkim=pass header.d=fernhollow.test"), "mx.cloudflare.net", "fernhollow.test")).toBe(true);
    expect(senderAuthenticated(h("evil.example; dmarc=pass"), "mx.cloudflare.net", "fernhollow.test")).toBe(false);
    // A forged header lower down does not count when ours (on top) fails.
    const forged = [{ key: "authentication-results", value: "mx.cloudflare.net; dmarc=fail" }, { key: "authentication-results", value: "mx.cloudflare.net; dmarc=pass" }];
    expect(senderAuthenticated(forged, "mx.cloudflare.net", "fernhollow.test")).toBe(false);
  });

  it("keeps only the new part of a reply", () => {
    expect(stripQuoted("Thanks, attached.\n\nOn Tue, Oct 6, 2026 at 9:00 AM Tend wrote:\n> old text")).toBe("Thanks, attached.");
    expect(stripQuoted("Yes\n> quoted\nNo")).toBe("Yes\nNo");
  });
});

describe("inbound email", () => {
  it("creates a record from mail to a queue address and confirms with a threaded reply-to", async () => {
    const before = email.sent.length;
    const r = await handleInboundEmail(worker(), {
      to: `${alias}@help.fernhollow.test`,
      raw: mime({ from: reqEmail, to: `${alias}@help.fernhollow.test`, subject: "Invoice 4471 short-paid", text: "We were paid $200 less than invoiced.", attachment: { name: "remit.csv", data: "a,b\n1,2" } }),
    });
    expect(r.outcome).toBe("record_created");
    const rec = (await agent.get(`/api/records/${r.key}`)).json.record;
    expect(rec).toMatchObject({ title: "Invoice 4471 short-paid", via: "email", description: "We were paid $200 less than invoiced." });
    const files = (await agent.get(`/api/records/${r.key}/attachments`)).json.attachments;
    expect(files.map((f: { filename: string }) => f.filename)).toEqual(["remit.csv"]);
    const confirm = email.sent.slice(before).find((m) => m.to === reqEmail)!;
    expect(confirm.subject).toBe(`[${r.key}] Invoice 4471 short-paid`);
    expect(confirm.replyTo).toMatch(/^reply\+[a-z2-7]{16}@help\.fernhollow\.test$/);
    expect(confirm.headers?.["In-Reply-To"]).toMatch(/@fernhollow\.test>$/);
  });

  it("threads replies onto the record as comments, and staff replies go back by email", async () => {
    const created = await handleInboundEmail(worker(), {
      to: `${alias}@help.fernhollow.test`,
      raw: mime({ from: reqEmail, to: `${alias}@help.fernhollow.test`, subject: "Vendor bank change", text: "Please update our bank details." }),
    });
    await agent.post(`/api/records/${created.key}/comments`, { body: "Please send a signed letter on letterhead." });
    const out = email.sent.filter((m) => m.to === reqEmail && m.subject.startsWith(`[${created.key}]`)).at(-1)!;
    expect(out.text).toContain("Please send a signed letter on letterhead.");
    expect(out.replyTo).toMatch(/^reply\+/);

    const reply = await handleInboundEmail(worker(), {
      to: out.replyTo!,
      raw: mime({ from: reqEmail, to: out.replyTo!, subject: `Re: ${out.subject}`, text: "Attached the letter.\n\nOn Mon someone wrote:\n> Please send a signed letter" }),
    });
    expect(reply).toMatchObject({ outcome: "comment_added", key: created.key });
    const comments = (await agent.get(`/api/records/${created.key}/comments`)).json.comments;
    expect(comments.at(-1)).toMatchObject({ body: "Attached the letter.", via: "email", internal: false });
  });

  it("drops duplicates and auto-replies, and refuses unverified or unknown senders", async () => {
    const id = `<${unique("dup")}@fernhollow.test>`;
    const msg = mime({ from: reqEmail, to: `${alias}@help.fernhollow.test`, subject: "Once", text: "x", messageId: id });
    expect((await handleInboundEmail(worker(), { to: `${alias}@help.fernhollow.test`, raw: msg })).outcome).toBe("record_created");
    expect((await handleInboundEmail(worker(), { to: `${alias}@help.fernhollow.test`, raw: msg })).outcome).toBe("duplicate");
    const auto = mime({ from: reqEmail, to: `${alias}@help.fernhollow.test`, subject: "Out of office", text: "away", extra: "Auto-Submitted: auto-replied" });
    expect((await handleInboundEmail(worker(), { to: `${alias}@help.fernhollow.test`, raw: auto })).outcome).toBe("auto_reply");
    const spoof = mime({ from: reqEmail, to: `${alias}@help.fernhollow.test`, subject: "Pay me", text: "x", auth: "mx.cloudflare.net; dmarc=fail; spf=fail" });
    expect((await handleInboundEmail(worker(), { to: `${alias}@help.fernhollow.test`, raw: spoof })).outcome).toBe("unauthenticated");
    const outsider = mime({ from: "someone@outside.test", to: `${alias}@help.fernhollow.test`, subject: "Hi", text: "x", auth: "mx.cloudflare.net; dmarc=pass header.from=outside.test" });
    expect((await handleInboundEmail(worker(), { to: `${alias}@help.fernhollow.test`, raw: outsider })).outcome).toBe("unknown_sender");
    expect((await handleInboundEmail(worker(), { to: "nobody@help.fernhollow.test", raw: msg })).outcome).toBe("unknown_address");
    expect((await handleInboundEmail(worker(), { to: `${alias}@other.test`, raw: msg })).outcome).toBe("unknown_address");
  });

  it("self-registers new requesters from allowed domains", async () => {
    const newcomer = `${unique("new")}@fernhollow.test`;
    const r = await handleInboundEmail(worker(), {
      to: `${alias}@help.fernhollow.test`,
      raw: mime({ from: newcomer, to: `${alias}@help.fernhollow.test`, subject: "First request", text: "Hello" }),
    });
    expect(r.outcome).toBe("record_created");
    const users = (await admin.get("/api/admin/users")).json.users;
    expect(users.find((u: { email: string }) => u.email === newcomer)).toMatchObject({ role: "requester" });
  });

  it("a reply from someone who cannot see the record is refused", async () => {
    const created = await handleInboundEmail(worker(), {
      to: `${alias}@help.fernhollow.test`,
      raw: mime({ from: reqEmail, to: `${alias}@help.fernhollow.test`, subject: "Private", text: "x" }),
    });
    await agent.post(`/api/records/${created.key}/comments`, { body: "ok" });
    const out = email.sent.filter((m) => m.to === reqEmail && m.subject.startsWith(`[${created.key}]`)).at(-1)!;
    const other = await addUser(sql, ws, "requester", `${unique("other")}@fernhollow.test`);
    const r = await handleInboundEmail(worker(), { to: out.replyTo!, raw: mime({ from: other.email, to: out.replyTo!, subject: "Re", text: "me too" }) });
    expect(r.outcome).toBe("not_allowed");
  });
});

describe("outbound email", () => {
  it("respects per-person preferences", async () => {
    const prefs = await req.get("/api/notification-prefs");
    expect(prefs.json.prefs.map((p: { kind: string }) => p.kind)).toEqual(["mention", "comment", "status", "received"]);
    await req.patch("/api/notification-prefs", { comment: { email: false } });
    const rec = (await req.post("/api/records", { recordTypeId, title: "Quiet please" })).json.record;
    const before = email.sent.length;
    await agent.post(`/api/records/${rec.key}/comments`, { body: "Reply without email" });
    expect(email.sent.slice(before).filter((m) => m.to === reqEmail).map((m) => m.subject + " " + m.text.slice(0, 60))).toEqual([]);
    expect((await req.get("/api/notifications")).json.notifications[0]).toMatchObject({ kind: "comment" });
    await req.patch("/api/notification-prefs", { comment: { email: true } });
    expect((await req.patch("/api/notification-prefs", { nonsense: { email: true } })).status).toBe(422);
  });

  it("staff emails carry no reply-to, and internal notes never reach requesters", async () => {
    const rec = (await req.post("/api/records", { recordTypeId, title: "Watch me" })).json.record;
    await agent.post(`/api/records/${rec.key}/watchers`, { watching: true });
    const before = email.sent.length;
    await admin.post(`/api/records/${rec.key}/comments`, { body: "Internal: vendor is on hold", internal: true });
    const sent = email.sent.slice(before);
    expect(sent.map((m) => m.to)).toEqual([agentEmail]);
    expect(sent[0]!.replyTo).toBeUndefined();
  });

  it("formats provider requests for Postmark and Resend", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ MessageID: "pm-1", id: "rs-1" }), { status: 200 });
    };
    const msg = { to: "a@b.test", subject: "S", text: "T", replyTo: "reply+abc@x.test", headers: { "In-Reply-To": "<1@x>" } };
    expect(await new PostmarkEmailSender("tok", "Tend <t@x.test>", fake).send(msg)).toBe("pm-1");
    expect(await new ResendEmailSender("key", "Tend <t@x.test>", fake).send(msg)).toBe("rs-1");
    expect(calls[0]!.url).toBe("https://api.postmarkapp.com/email");
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({ From: "Tend <t@x.test>", ReplyTo: "reply+abc@x.test", Headers: [{ Name: "In-Reply-To", Value: "<1@x>" }] });
    expect((calls[1]!.init.headers as Record<string, string>).authorization).toBe("Bearer key");
    expect(JSON.parse(calls[1]!.init.body as string)).toMatchObject({ to: ["a@b.test"], reply_to: "reply+abc@x.test" });
    const failing = async () => new Response("nope", { status: 422 });
    await expect(new ResendEmailSender("key", "t@x.test", failing).send(msg)).rejects.toThrow(/Resend rejected/);
  });
});
