// Install a starter template through the ordinary configuration services.
import { z } from "zod";
import type { Tx } from "../db/client.ts";
import { audit, type Actor } from "../audit.ts";
import { createField, createProject, createRecordType, updateProject, type Project } from "../config/service.ts";
import { publishDefinition } from "../config/versions.ts";
import { createTeam } from "../teams/service.ts";
import { AppError, invalid, notFound } from "../lib/errors.ts";
import { parse, uuid } from "../lib/validate.ts";
import { getTemplate, type Template } from "./catalog.ts";

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
  /** Team that owns the queue. Defaults to a team named in the template (created if missing). */
  teamId: uuid.nullable().optional(),
  /** Calendar for business-hours SLA targets. Defaults to "Business hours" (created if missing). */
  calendarId: uuid.nullable().optional(),
});
export type InstallInput = z.input<typeof installSchema>;

const WEEKDAYS_9_TO_5 = Object.fromEntries(["mon", "tue", "wed", "thu", "fri"].map((d) => [d, [["09:00", "17:00"]]]));

async function resolveTeam(tx: Tx, actor: Actor, t: Template, teamId: string | null | undefined): Promise<string | null> {
  if (teamId === null) return null;
  if (teamId) return teamId; // updateProject checks it exists
  const [existing] = await tx<{ id: string }[]>`select id from teams where name = ${t.team} and archived_at is null`;
  if (existing) return existing.id;
  return (await createTeam(tx, actor, { name: t.team, memberIds: [] })).id;
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

export interface InstalledTemplate {
  project: Project;
  recordTypeId: string;
  teamId: string | null;
  calendarId: string | null;
}

export async function installTemplate(tx: Tx, actor: Actor, key: string, input: unknown = {}): Promise<InstalledTemplate> {
  const t = getTemplate(key);
  if (!t) throw notFound("Template");
  const opts = parse(installSchema, input ?? {});
  const needsApprovers = t.workflow.transitions.some((tr) => tr.approval);
  const approvers = needsApprovers ? await resolveApprovers(tx, actor, opts.approverIds) : [];
  const needsCalendar = t.sla?.policies.some((p) => p.businessHours) ?? false;
  const calendarId = needsCalendar ? await resolveCalendar(tx, actor, opts.calendarId) : null;
  const teamId = await resolveTeam(tx, actor, t, opts.teamId);

  const projectKey = opts.projectKey ?? t.project.key;
  const [taken] = await tx`select 1 from projects where key = ${projectKey}`;
  if (taken) throw invalid([{ field: "projectKey", message: `A project with key ${projectKey} already exists; choose another key` }]);

  const created = await createProject(tx, actor, {
    key: projectKey,
    name: opts.projectName ?? t.project.name,
    description: t.project.description,
  });
  const recordType = await createRecordType(tx, actor, created.id, t.recordType);
  for (const [i, f] of t.fields.entries()) await createField(tx, actor, recordType.id, { ...f, position: i });

  await publishDefinition(tx, actor, "workflow", recordType.id, {
    initial: t.workflow.initial,
    statuses: t.workflow.statuses,
    transitions: t.workflow.transitions.map(({ approval, ...tr }) => ({
      ...tr,
      ...(approval ? { approval: { mode: approval.mode, approvers } } : {}),
    })),
  });
  if (t.layout) await publishDefinition(tx, actor, "layout", recordType.id, t.layout);
  if (t.sla) {
    await publishDefinition(tx, actor, "sla", created.id, {
      policies: t.sla.policies.map((p) => ({
        name: p.name,
        match: { priorities: p.priorities, recordTypeIds: [] },
        firstResponseMinutes: p.firstResponseMinutes,
        resolutionMinutes: p.resolutionMinutes,
        calendarId: p.businessHours ? calendarId : null,
        warnPercent: p.warnPercent,
      })),
      pauseStatuses: t.sla.pauseStatuses,
    });
  }
  const project = await updateProject(tx, actor, created.id, {
    restricted: t.project.restricted,
    assignment: t.project.assignment,
    defaultTeamId: teamId,
  });
  await audit(tx, actor, { entity: "template", entityId: project.id, action: "install", after: { template: t.key, projectKey } });
  return { project, recordTypeId: recordType.id, teamId, calendarId };
}
