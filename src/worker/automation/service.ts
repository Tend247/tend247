// Automation rules: when an event happens in a project and the conditions match, run the
// actions (set a field, assign, transition, notify, call a webhook, create a linked record,
// comment). Rules run as the system, after the change that triggered them. A rule never
// re-triggers itself, and chains stop after three rule runs.
import { z } from "zod";
import type { Tx } from "../db/client.ts";
import { audit, systemActor, type Actor } from "../audit.ts";
import { AppError, invalid, notFound } from "../lib/errors.ts";
import { isUuid } from "../lib/crypto.ts";
import { configKey, parse, parsePatch, uuid } from "../lib/validate.ts";
import { getProject, listFields } from "../config/service.ts";
import { loadRecord, type RecordRow } from "../records/access.ts";
import { applyPatch, createRecord, recordEvent, recordPatchSchema } from "../records/service.ts";
import { runTransition } from "../records/transitions.ts";
import { createComment } from "../comments/service.ts";
import { nextRoundRobin } from "../teams/service.ts";
import { notify, type NewNotification } from "../notifications/service.ts";
import { scheduleJob } from "../jobs/schedule.ts";
import { BUILTIN_FIELDS } from "../workflow/definition.ts";

export const TRIGGERS = [
  "record.created",
  "record.updated",
  "record.transitioned",
  "comment.created",
  "sla.warning",
  "sla.breached",
  "approval.decided",
] as const;
export type Trigger = (typeof TRIGGERS)[number];

export const MAX_CHAIN_DEPTH = 3;

const conditionSchema = z.object({
  /** A record field (priority, status, statusCategory, assigneeId, teamId, requesterId, recordTypeId,
   *  title, description, via, custom.<key>) or an event field (event.<name>). */
  field: z.string().regex(/^(event\.[a-zA-Z]+|custom\.[a-z][a-z0-9_]{0,62}|[a-zA-Z]+)$/),
  op: z.enum(["eq", "neq", "in", "not_in", "contains", "empty", "not_empty", "changed"]),
  value: z.unknown().optional(),
});

const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("set_field"), field: z.string().min(1).max(80), value: z.unknown() }),
  z.object({ type: z.literal("assign"), userId: uuid.nullable().optional(), roundRobinTeamId: uuid.optional() }),
  z.object({ type: z.literal("set_team"), teamId: uuid.nullable() }),
  z.object({ type: z.literal("transition"), transition: configKey }),
  z.object({
    type: z.literal("notify"),
    to: z.array(z.union([z.enum(["assignee", "requester", "watchers", "team"]), uuid])).min(1).max(20),
    message: z.string().trim().min(1).max(1000),
  }),
  z.object({ type: z.literal("webhook"), url: z.string().url().max(2000) }),
  z.object({
    type: z.literal("create_linked"),
    recordTypeId: uuid,
    title: z.string().trim().min(1).max(500),
    linkKind: z.enum(["relates", "blocks", "duplicates", "parent"]).default("relates"),
  }),
  z.object({ type: z.literal("comment"), body: z.string().trim().min(1).max(10_000), internal: z.boolean().default(true) }),
]);

const ruleSchema = z.object({
  name: z.string().trim().min(1).max(200),
  projectId: uuid.nullable().default(null),
  enabled: z.boolean().default(true),
  trigger: z.enum(TRIGGERS),
  conditions: z.array(conditionSchema).max(20).default([]),
  actions: z.array(actionSchema).min(1).max(10),
  position: z.number().int().min(0).max(10_000).default(0),
});
const rulePatchSchema = ruleSchema.partial().strict();

export type Rule = z.infer<typeof ruleSchema> & { id: string; createdAt: Date; updatedAt: Date };
export type Condition = z.infer<typeof conditionSchema>;
export type Action = z.infer<typeof actionSchema>;

const COLUMNS = (tx: Tx) => tx`id, name, project_id, enabled, trigger, conditions, actions, position, created_at, updated_at`;

function checkWebhookUrl(url: string, allowHttp: boolean): string | null {
  const u = new URL(url);
  if (u.protocol !== "https:" && !(allowHttp && u.protocol === "http:")) return "Webhooks must use https";
  const host = u.hostname.toLowerCase().replace(/\.+$/, "");
  if (
    !host.includes(".") ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    /^(\d+\.){3}\d+$/.test(host) ||
    host.startsWith("[")
  ) {
    return "Use a public host name, not an IP address or local name";
  }
  return null;
}

async function validateRule(tx: Tx, rule: z.infer<typeof ruleSchema>, allowHttp: boolean): Promise<void> {
  const issues = [];
  if (rule.projectId) await getProject(tx, rule.projectId);
  for (const [i, a] of rule.actions.entries()) {
    if (a.type === "webhook") {
      const problem = checkWebhookUrl(a.url, allowHttp);
      if (problem) issues.push({ field: `actions.${i}.url`, message: problem });
    }
    if (a.type === "create_linked") {
      const [rt] = await tx`select 1 from record_types where id = ${a.recordTypeId} and archived_at is null`;
      if (!rt) issues.push({ field: `actions.${i}.recordTypeId`, message: "Unknown record type" });
    }
  }
  if (issues.length) throw invalid(issues);
}

export async function listRules(tx: Tx): Promise<Rule[]> {
  return tx<Rule[]>`select ${COLUMNS(tx)} from automation_rules order by position, created_at`;
}

async function getRule(tx: Tx, id: string): Promise<Rule> {
  if (!isUuid(id)) throw notFound("Rule");
  const [r] = await tx<Rule[]>`select ${COLUMNS(tx)} from automation_rules where id = ${id}`;
  if (!r) throw notFound("Rule");
  return r;
}

export async function createRule(tx: Tx, actor: Actor, input: unknown, opts: { allowHttp?: boolean } = {}): Promise<Rule> {
  const data = parse(ruleSchema, input);
  await validateRule(tx, data, opts.allowHttp ?? false);
  const [row] = await tx<{ id: string }[]>`
    insert into automation_rules (tenant_id, project_id, name, enabled, trigger, conditions, actions, position, created_by)
    values (${actor.tenantId}, ${data.projectId}, ${data.name}, ${data.enabled}, ${data.trigger},
            ${tx.json(data.conditions as never)}, ${tx.json(data.actions as never)}, ${data.position}, ${actor.userId})
    returning id`;
  const rule = await getRule(tx, row!.id);
  await audit(tx, actor, { entity: "automation_rule", entityId: rule.id, action: "create", after: rule });
  return rule;
}

export async function updateRule(tx: Tx, actor: Actor, id: string, input: unknown, opts: { allowHttp?: boolean } = {}): Promise<Rule> {
  const patch = parsePatch(rulePatchSchema, input);
  const before = await getRule(tx, id);
  const next = { ...before, ...patch };
  await validateRule(tx, parse(ruleSchema, next), opts.allowHttp ?? false);
  await tx`
    update automation_rules set name = ${next.name}, project_id = ${next.projectId}, enabled = ${next.enabled},
      trigger = ${next.trigger}, conditions = ${tx.json(next.conditions as never)}, actions = ${tx.json(next.actions as never)},
      position = ${next.position}, updated_at = now()
    where id = ${before.id}`;
  const after = await getRule(tx, before.id);
  await audit(tx, actor, { entity: "automation_rule", entityId: before.id, action: "update", before, after });
  return after;
}

export async function deleteRule(tx: Tx, actor: Actor, id: string): Promise<void> {
  const before = await getRule(tx, id);
  await tx`delete from automation_rules where id = ${before.id}`;
  await audit(tx, actor, { entity: "automation_rule", entityId: before.id, action: "delete", before });
}

// ---------------------------------------------------------------- evaluation

function valueOf(record: RecordRow, event: Record<string, unknown>, field: string): unknown {
  if (field.startsWith("event.")) return event[field.slice(6)];
  if (field.startsWith("custom.")) return record.custom[field.slice(7)];
  return (record as unknown as Record<string, unknown>)[field];
}

const empty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

export function matches(record: RecordRow, event: Record<string, unknown>, conditions: Condition[]): boolean {
  return conditions.every((c) => {
    const v = valueOf(record, event, c.field);
    switch (c.op) {
      case "eq":
        return JSON.stringify(v ?? null) === JSON.stringify(c.value ?? null);
      case "neq":
        return JSON.stringify(v ?? null) !== JSON.stringify(c.value ?? null);
      case "in":
        return Array.isArray(c.value) && c.value.some((x) => JSON.stringify(x) === JSON.stringify(v));
      case "not_in":
        return Array.isArray(c.value) && !c.value.some((x) => JSON.stringify(x) === JSON.stringify(v));
      case "contains":
        if (Array.isArray(v)) return v.includes(c.value);
        return typeof v === "string" && typeof c.value === "string" && v.toLowerCase().includes(c.value.toLowerCase());
      case "empty":
        return empty(v);
      case "not_empty":
        return !empty(v);
      case "changed": {
        const fields = Array.isArray(event.fields) ? (event.fields as string[]) : [];
        return fields.includes(c.field);
      }
    }
  });
}

/** Turn "{{key}}: {{title}}" style templates into text using the record. */
export function renderTemplate(template: string, record: RecordRow): string {
  return template.replace(/\{\{\s*(key|title|status|priority)\s*\}\}/g, (_m, k: string) => String((record as unknown as Record<string, unknown>)[k] ?? ""));
}

export interface AutomationResult {
  notifications: Awaited<ReturnType<typeof notify>>;
}

/**
 * Run the enabled rules for one outbox event. Each rule runs in its own savepoint: a failing
 * rule is logged on the record and the others still run.
 */
export async function runAutomation(
  tx: Tx,
  tenantId: string,
  event: { id: string; topic: string; payload: Record<string, unknown> },
): Promise<AutomationResult> {
  const out: AutomationResult = { notifications: [] };
  if (!(TRIGGERS as readonly string[]).includes(event.topic)) return out;
  const chain = (event.payload.chain as { depth: number; ruleIds: string[] } | undefined) ?? { depth: 0, ruleIds: [] };
  if (chain.depth >= MAX_CHAIN_DEPTH) return out;
  const recordId = event.payload.recordId as string | undefined;
  if (!recordId) return out;
  const base = systemActor(tenantId);
  const record = await loadRecord(tx, base, recordId);
  if (!record) return out;
  const rules = await tx<Rule[]>`
    select ${COLUMNS(tx)} from automation_rules
    where enabled and trigger = ${event.topic} and (project_id is null or project_id = ${record.projectId})
    order by position, created_at`;
  for (const rule of rules) {
    if (chain.ruleIds.includes(rule.id)) continue;
    const current = await loadRecord(tx, base, recordId);
    if (!current || !matches(current, event.payload, rule.conditions)) continue;
    const actor: Actor = { ...base, chain: { depth: chain.depth + 1, ruleIds: [...chain.ruleIds, rule.id] } };
    try {
      await tx.savepoint(async (sp) => {
        for (const action of rule.actions) {
          const fresh = (await loadRecord(sp as Tx, actor, recordId, { lock: true }))!;
          out.notifications.push(...(await runAction(sp as Tx, actor, fresh, action, event)));
        }
        await recordEvent(sp as Tx, actor, recordId, "automation_ran", { ruleId: rule.id, rule: rule.name, trigger: event.topic });
      });
    } catch (err) {
      const message = err instanceof AppError ? (err.details?.issues?.[0]?.message ?? err.message) : "unexpected error";
      if (!(err instanceof AppError)) console.error("automation rule failed:", rule.id, (err as Error).message);
      await recordEvent(tx, base, recordId, "automation_failed", { ruleId: rule.id, rule: rule.name, error: message });
    }
  }
  return out;
}

async function runAction(tx: Tx, actor: Actor, record: RecordRow, action: Action, event: { id: string; topic: string }) {
  switch (action.type) {
    case "set_field": {
      const builtin = (BUILTIN_FIELDS as readonly string[]).includes(action.field);
      const patch = builtin ? { [action.field]: action.value } : { custom: { [action.field.replace(/^custom\./, "")]: action.value } };
      await applyPatch(tx, actor, record, parse(recordPatchSchema, patch));
      return [];
    }
    case "assign": {
      let assigneeId = action.userId ?? null;
      if (action.roundRobinTeamId) assigneeId = await nextRoundRobin(tx, action.roundRobinTeamId);
      await applyPatch(tx, actor, record, { assigneeId, ...(action.roundRobinTeamId ? { teamId: action.roundRobinTeamId } : {}) });
      return [];
    }
    case "set_team":
      await applyPatch(tx, actor, record, { teamId: action.teamId });
      return [];
    case "transition":
      await runTransition(tx, actor, record, action.transition);
      return [];
    case "comment":
      await createComment(tx, actor, record.id, { body: renderTemplate(action.body, record), internal: action.internal });
      return [];
    case "create_linked": {
      // Values carry over for fields the new record's type shares (same key).
      const keys = new Set((await listFields(tx, action.recordTypeId)).map((f) => f.key));
      const custom = Object.fromEntries(Object.entries(record.custom).filter(([k]) => keys.has(k)));
      const created = await createRecord(tx, actor, {
        recordTypeId: action.recordTypeId,
        title: renderTemplate(action.title, record).slice(0, 500),
        requesterId: record.requesterId,
        custom,
      });
      await tx`
        insert into record_links (tenant_id, from_id, to_id, kind) values (${actor.tenantId}, ${record.id}, ${created.id}, ${action.linkKind})
        on conflict do nothing`;
      await recordEvent(tx, actor, record.id, "linked", { kind: action.linkKind, to: created.key });
      return [];
    }
    case "webhook": {
      const [d] = await tx<{ id: string }[]>`
        insert into webhook_deliveries (tenant_id, rule_id, url, payload)
        values (${actor.tenantId}, ${actor.chain?.ruleIds.at(-1) ?? null}, ${action.url},
                ${tx.json({ event: event.topic, eventId: event.id, record: publicRecord(record) } as never)})
        returning id`;
      await scheduleJob(tx, actor.tenantId, "webhook", d!.id, new Date());
      return [];
    }
    case "notify": {
      const ids = new Set<string>();
      for (const to of action.to) {
        if (to === "assignee" && record.assigneeId) ids.add(record.assigneeId);
        else if (to === "requester" && record.requesterId) ids.add(record.requesterId);
        else if (to === "watchers") {
          for (const w of await tx<{ userId: string }[]>`select user_id from record_watchers where record_id = ${record.id}`) ids.add(w.userId);
        } else if (to === "team" && record.teamId) {
          for (const m of await tx<{ userId: string }[]>`select user_id from team_members where team_id = ${record.teamId}`) ids.add(m.userId);
        } else if (isUuid(to)) ids.add(to);
      }
      const items: NewNotification[] = [...ids].map((userId) => ({
        userId,
        kind: "automation",
        recordId: record.id,
        title: `${record.key}: ${renderTemplate(action.message, record)}`,
      }));
      return notify(tx, actor.tenantId, event.id, items);
    }
  }
}

/** The record as sent to webhooks: no internal-only data beyond the record's own fields. */
export function publicRecord(r: RecordRow) {
  return {
    id: r.id,
    key: r.key,
    title: r.title,
    status: r.status,
    statusCategory: r.statusCategory,
    priority: r.priority,
    assigneeId: r.assigneeId,
    requesterId: r.requesterId,
    teamId: r.teamId,
    projectId: r.projectId,
    recordTypeId: r.recordTypeId,
    custom: r.custom,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}
