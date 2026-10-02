// Install a template (built-in, saved, from a file or built by the setup wizard) through the
// ordinary configuration services, in the caller's transaction: it lands whole or not at all.
import { z } from "zod";
import type { Tx } from "../db/client.ts";
import { audit, type Actor } from "../audit.ts";
import { createField, createProject, createRecordType, updateProject, type Project } from "../config/service.ts";
import { publishDefinition } from "../config/versions.ts";
import { createTeam } from "../teams/service.ts";
import { createRule } from "../automation/service.ts";
import { AppError, invalid, notFound, type FieldIssue } from "../lib/errors.ts";
import { isUuid } from "../lib/crypto.ts";
import { parse, uuid } from "../lib/validate.ts";
import { getTemplate } from "./catalog.ts";
import { templateSchema, type TemplateDefinition } from "./definition.ts";

const installSchema = z.object({
  /** Override the project key (it must be unique in the workspace), e.g. when HR is taken. */
  projectKey: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9]{1,9}$/, "2–10 capital letters or digits, starting with a letter")
    .optional(),
  projectName: z.string().trim().min(1).max(200).optional(),
  /** Who approves gated transitions. Defaults to the installing admin. */
  approverIds: z.array(uuid).min(1).max(10).optional(),
  /** Team that owns the queue. Defaults to the template's team (found by name or created). */
  teamId: uuid.nullable().optional(),
  /** Calendar for business-hours SLA targets. Defaults to "Business hours" (created if missing). */
  calendarId: uuid.nullable().optional(),
});
export type InstallInput = z.input<typeof installSchema>;

const WEEKDAYS_9_TO_5 = Object.fromEntries(["mon", "tue", "wed", "thu", "fri"].map((d) => [d, [["09:00", "17:00"]]]));

async function resolveTeam(tx: Tx, actor: Actor, name: string | null, teamId: string | null | undefined): Promise<string | null> {
  if (teamId === null) return null;
  if (teamId) return teamId; // updateProject checks it exists
  if (!name) return null;
  const [existing] = await tx<{ id: string }[]>`select id from teams where name = ${name} and archived_at is null`;
  if (existing) return existing.id;
  return (await createTeam(tx, actor, { name, memberIds: [] })).id;
}

async function resolveCalendar(tx: Tx, actor: Actor, calendarId: string | null | undefined): Promise<string | null> {
  if (calendarId === null) return null;
  if (calendarId) {
    const [c] = await tx`select 1 from calendars where id = ${calendarId}`;
    if (!c) throw invalid([{ field: "calendarId", message: "Unknown calendar" }]);
    return calendarId;
  }
  const [existing] = await tx<{ id: string }[]>`select id from calendars where name = 'Business hours'`;
  if (existing) return existing.id;
  const [ws] = await tx<{ timezone: string | null }[]>`select settings ->> 'timezone' as timezone from tenants where id = ${actor.tenantId}`;
  const [row] = await tx<{ id: string }[]>`
    insert into calendars (tenant_id, name, timezone, hours, holidays)
    values (${actor.tenantId}, 'Business hours', ${ws?.timezone || "UTC"}, ${tx.json(WEEKDAYS_9_TO_5 as never)}, ${tx.json([])})
    returning id`;
  await audit(tx, actor, { entity: "calendar", entityId: row!.id, action: "create", after: { name: "Business hours" } });
  return row!.id;
}

async function resolveApprovers(tx: Tx, actor: Actor, ids: string[] | undefined): Promise<string[]> {
  const wanted = ids ?? (actor.userId ? [actor.userId] : []);
  if (!wanted.length) throw new AppError("bad_request", "Choose who approves requests in this template");
  const ok = await tx<{ id: string }[]>`
    select id from users where active and role in ('admin', 'agent')
      and id in (select (jsonb_array_elements_text(${tx.json(wanted)}))::uuid)`;
  const found = new Set(ok.map((u) => u.id));
  const bad = wanted.findIndex((id) => !found.has(id));
  if (bad >= 0) throw invalid([{ field: `approverIds.${bad}`, message: "Approvers must be active admins or agents" }]);
  return wanted;
}

/** Prefix field paths so a problem points at the part of the template it came from. */
async function within<T>(path: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError && err.details?.issues) {
      const issues = (err.details.issues as FieldIssue[]).map((i) => ({ field: i.field ? `${path}.${i.field}` : path, message: i.message }));
      throw invalid(issues, err.message);
    }
    if (err instanceof AppError) throw invalid([{ field: path, message: err.message }], err.message);
    throw err;
  }
}

export interface InstalledTemplate {
  project: Project;
  recordTypeId: string;
  recordTypeIds: Record<string, string>;
  teamId: string | null;
  calendarId: string | null;
}

/** Validate a template definition from outside (a saved row, an uploaded file, the wizard). */
export function parseDefinition(input: unknown): TemplateDefinition {
  const r = templateSchema.safeParse(input);
  if (!r.success) {
    throw invalid(
      r.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })),
      "This is not a valid Tend 24/7 template",
    );
  }
  return r.data;
}

export async function installDefinition(tx: Tx, actor: Actor, def: TemplateDefinition, input: unknown = {}): Promise<InstalledTemplate> {
  const opts = parse(installSchema, input ?? {});
  const needsApprovers = def.recordTypes.some((r) => r.workflow.transitions.some((tr) => tr.approval));
  const approvers = needsApprovers ? await resolveApprovers(tx, actor, opts.approverIds) : [];
  const needsCalendar = def.sla?.policies.some((p) => p.businessHours) ?? false;
  const calendarId = needsCalendar ? await resolveCalendar(tx, actor, opts.calendarId) : null;
  const teamId = await resolveTeam(tx, actor, def.team, opts.teamId);

  const projectKey = opts.projectKey ?? def.project.key;
  const [taken] = await tx`select 1 from projects where key = ${projectKey}`;
  if (taken) throw invalid([{ field: "projectKey", message: `A project with key ${projectKey} already exists; choose another key` }]);

  const created = await within("project", () =>
    createProject(tx, actor, { key: projectKey, name: opts.projectName ?? def.project.name, description: def.project.description }),
  );
  const ids: Record<string, string> = {};
  for (const [i, rt] of def.recordTypes.entries()) {
    const path = `recordTypes.${i}`;
    const type = await within(path, () => createRecordType(tx, actor, created.id, { key: rt.key, name: rt.name, description: rt.description }));
    ids[rt.key] = type.id;
    if (rt.isEpic) await tx`update record_types set is_epic = true where id = ${type.id}`;
    for (const [j, f] of rt.fields.entries()) {
      await within(`${path}.fields.${j}`, () => createField(tx, actor, type.id, { ...f, position: j }));
    }
    await within(`${path}.workflow`, () =>
      publishDefinition(tx, actor, "workflow", type.id, {
        initial: rt.workflow.initial,
        statuses: rt.workflow.statuses,
        transitions: rt.workflow.transitions.map(({ approval, ...tr }) => ({
          ...tr,
          ...(approval ? { approval: { mode: approval.mode, approvers } } : {}),
        })),
      }),
    );
    if (rt.layout) await within(`${path}.layout`, () => publishDefinition(tx, actor, "layout", type.id, rt.layout));
  }
  if (def.sla?.policies.length) {
    await within("sla", () =>
      publishDefinition(tx, actor, "sla", created.id, {
        policies: def.sla!.policies.map((p) => ({
          name: p.name,
          match: { priorities: p.priorities, recordTypeIds: p.recordTypes.map((k) => ids[k]!) },
          firstResponseMinutes: p.firstResponseMinutes,
          resolutionMinutes: p.resolutionMinutes,
          calendarId: p.businessHours ? calendarId : null,
          warnPercent: p.warnPercent,
        })),
        pauseStatuses: def.sla!.pauseStatuses,
      }),
    );
  }
  const project = await updateProject(tx, actor, created.id, {
    restricted: def.project.restricted,
    requesterAccess: def.project.requesterAccess,
    assignment: def.project.assignment,
    agile: def.project.agile,
    defaultTeamId: teamId,
  });
  for (const [i, rule] of def.automation.entries()) {
    const actions = rule.actions.map((a) => {
      const action = { ...a } as Record<string, unknown>;
      if (action.type === "create_linked") {
        const target = ids[String(action.recordTypeKey ?? "")];
        if (!target) throw invalid([{ field: `automation.${i}`, message: `Unknown record type "${String(action.recordTypeKey)}"` }]);
        delete action.recordTypeKey;
        action.recordTypeId = target;
      }
      if (action.type === "set_team" && action.teamId === "$team") action.teamId = teamId;
      if (action.type === "assign" && action.roundRobinTeamId === "$team") {
        if (teamId) action.roundRobinTeamId = teamId;
        else delete action.roundRobinTeamId;
      }
      return action;
    });
    await within(`automation.${i}`, () =>
      createRule(tx, actor, { name: rule.name, enabled: rule.enabled, trigger: rule.trigger, conditions: rule.conditions, actions, projectId: created.id }),
    );
  }
  await audit(tx, actor, { entity: "template", entityId: project.id, action: "install", after: { template: def.name, projectKey } });
  const first = def.recordTypes.find((r) => !r.isEpic) ?? def.recordTypes[0]!;
  return { project, recordTypeId: ids[first.key]!, recordTypeIds: ids, teamId, calendarId };
}

/** Install a built-in template by key, or a saved template by id. */
export async function installTemplate(tx: Tx, actor: Actor, keyOrId: string, input: unknown = {}): Promise<InstalledTemplate> {
  const builtin = getTemplate(keyOrId);
  if (builtin) return installDefinition(tx, actor, builtin.definition, input);
  if (isUuid(keyOrId)) {
    const [saved] = await tx<{ definition: unknown }[]>`select definition from workspace_templates where id = ${keyOrId}`;
    if (saved) return installDefinition(tx, actor, parseDefinition(saved.definition), input);
  }
  throw notFound("Template");
}

class DryRun extends Error {}

/**
 * Install inside a savepoint and roll it back: the wizard's "check" step and file uploads see
 * exactly the problems a real install would hit, and nothing is saved.
 */
export async function checkDefinition(tx: Tx, actor: Actor, input: unknown, opts: unknown = {}, check: { anyKey?: boolean } = {}) {
  const def = parseDefinition(input);
  try {
    await tx.savepoint(async (sp) => {
      let options = opts;
      if (check.anyKey) {
        // Saving, not installing: a project key already in use here is not a problem yet.
        const [taken] = await sp`select 1 from projects where key = ${def.project.key}`;
        if (taken) options = { ...(opts as object), projectKey: `Z${Date.now().toString(36).toUpperCase().slice(-8)}` };
      }
      await installDefinition(sp as unknown as Tx, actor, def, options);
      throw new DryRun();
    });
  } catch (err) {
    if (!(err instanceof DryRun)) throw err;
  }
  return def;
}
