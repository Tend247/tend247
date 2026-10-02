// "Save as template": turn a configured project into a template definition, without records,
// people or secrets. What only makes sense inside this workspace is generalised or left out,
// and each omission is reported so the admin knows what to set again after installing:
//   approvers         → "$approvers" (chosen at install)
//   the SLA calendar  → businessHours (the calendar is chosen at install)
//   the default team  → its name (found or created at install)
//   person-specific automation (assign to Sam, notify Dana), webhooks (their URLs can carry
//   secrets) and conditions on particular people → left out, with a warning
import type { Tx } from "../db/client.ts";
import { getProject, listFields } from "../config/service.ts";
import { getPublished } from "../config/versions.ts";
import { listRules } from "../automation/service.ts";
import { isUuid } from "../lib/crypto.ts";
import { notFound } from "../lib/errors.ts";
import { TEMPLATE_FORMAT, TEMPLATE_VERSION, type TemplateDefinition } from "./definition.ts";
import { parseDefinition } from "./install.ts";
import type { WorkflowDefinition } from "../workflow/definition.ts";
import type { LayoutDefinition } from "../workflow/layout.ts";
import type { SlaDefinition } from "../sla/definition.ts";

export async function projectToDefinition(
  tx: Tx,
  projectId: string,
  meta: { name: string; summary?: string },
): Promise<{ definition: TemplateDefinition; warnings: string[] }> {
  if (!isUuid(projectId)) throw notFound("Project");
  const project = await getProject(tx, projectId);
  const warnings: string[] = [];
  const types = await tx<{ id: string; key: string; name: string; description: string; isEpic: boolean }[]>`
    select id, key, name, description, is_epic from record_types where project_id = ${project.id} and archived_at is null order by created_at`;
  if (!types.length) warnings.push("The project has no active record types");
  const keyOf = new Map(types.map((t) => [t.id, t.key]));
  const [team] = project.defaultTeamId ? await tx<{ name: string }[]>`select name from teams where id = ${project.defaultTeamId}` : [];

  const recordTypes = [];
  for (const t of types) {
    const fields = (await listFields(tx, t.id)).map((f) => {
      const field: Record<string, unknown> = { key: f.key, label: f.label, type: f.type, required: f.required, options: f.options, helpText: f.helpText };
      if (f.defaultValue !== null && f.defaultValue !== undefined && f.type !== "user") field.defaultValue = f.defaultValue;
      return field;
    });
    const wf = (await getPublished(tx, "workflow", t.id))?.definition as WorkflowDefinition;
    const transitions = wf.transitions.map((tr) => {
      const { approval, actions, ...rest } = tr;
      const kept = actions.filter((a) => {
        if (a.type === "set_field" && typeof a.value === "string" && isUuid(a.value)) {
          warnings.push(`${t.name}: "${tr.name}" sets a field to a particular person; that action was left out`);
          return false;
        }
        return true;
      });
      return { ...rest, actions: kept, ...(approval ? { approval: { mode: approval.mode, approvers: ["$approvers"] as ["$approvers"] } } : {}) };
    });
    if (wf.transitions.some((tr) => tr.approval)) warnings.push(`${t.name}: approvers are chosen when the template is installed`);
    const layout = (await getPublished(tx, "layout", t.id))?.definition as LayoutDefinition | undefined;
    recordTypes.push({
      key: t.key,
      name: t.name,
      description: t.description,
      isEpic: t.isEpic,
      fields,
      workflow: { initial: wf.initial, statuses: wf.statuses, transitions },
      ...(layout ? { layout } : {}),
    });
  }

  const slaDef = (await getPublished(tx, "sla", project.id))?.definition as SlaDefinition | undefined;
  const sla = slaDef?.policies.length
    ? {
        policies: slaDef.policies.map((p) => ({
          name: p.name,
          priorities: p.match.priorities,
          recordTypes: p.match.recordTypeIds.map((id) => keyOf.get(id)).filter((k): k is string => Boolean(k)),
          firstResponseMinutes: p.firstResponseMinutes,
          resolutionMinutes: p.resolutionMinutes,
          businessHours: Boolean(p.calendarId),
          warnPercent: p.warnPercent,
        })),
        pauseStatuses: slaDef.pauseStatuses,
      }
    : undefined;
  if (slaDef?.policies.some((p) => p.calendarId)) warnings.push("SLA targets on business hours use the calendar chosen at install");

  const automation = [];
  for (const rule of (await listRules(tx)).filter((r) => r.projectId === project.id)) {
    const personal = (v: unknown) => typeof v === "string" && isUuid(v);
    if (rule.conditions.some((c) => personal(c.value) || (Array.isArray(c.value) && c.value.some(personal)))) {
      warnings.push(`Automation "${rule.name}" depends on particular people and was left out`);
      continue;
    }
    const actions = [];
    for (const a of rule.actions) {
      const action = { ...a } as Record<string, unknown>;
      const personal2 = (v: unknown) => personal(v) || (Array.isArray(v) && v.some(personal));
      if (a.type === "set_field" && personal2(a.value)) {
        warnings.push(`Automation "${rule.name}": setting a field to a particular person was left out`);
        continue;
      }
      if (a.type === "webhook") {
        warnings.push(`Automation "${rule.name}": the webhook action was left out (its URL may carry a secret)`);
        continue;
      }
      if (a.type === "assign" && a.userId) {
        warnings.push(`Automation "${rule.name}": assigning to a particular person was left out`);
        continue;
      }
      if (a.type === "assign" && a.roundRobinTeamId) {
        if (a.roundRobinTeamId !== project.defaultTeamId) {
          warnings.push(`Automation "${rule.name}": round-robin to another team was left out`);
          continue;
        }
        action.roundRobinTeamId = "$team";
      }
      if (a.type === "set_team" && a.teamId) {
        if (a.teamId !== project.defaultTeamId) {
          warnings.push(`Automation "${rule.name}": moving records to another team was left out`);
          continue;
        }
        action.teamId = "$team";
      }
      if (a.type === "notify") {
        const to = a.to.filter((x) => !isUuid(x));
        if (to.length < a.to.length) warnings.push(`Automation "${rule.name}": notifying particular people was left out`);
        if (!to.length) continue;
        action.to = to;
      }
      if (a.type === "create_linked") {
        const k = keyOf.get(a.recordTypeId);
        if (!k) {
          warnings.push(`Automation "${rule.name}": creating a record in another project was left out`);
          continue;
        }
        delete action.recordTypeId;
        action.recordTypeKey = k;
      }
      actions.push(action);
    }
    if (!actions.length) continue;
    automation.push({ name: rule.name, enabled: rule.enabled, trigger: rule.trigger, conditions: rule.conditions as Record<string, unknown>[], actions });
  }

  const definition = parseDefinition({
    format: TEMPLATE_FORMAT,
    version: TEMPLATE_VERSION,
    name: meta.name,
    summary: meta.summary ?? project.description.slice(0, 500),
    project: {
      key: project.key,
      name: project.name,
      description: project.description,
      restricted: project.restricted,
      requesterAccess: project.requesterAccess,
      assignment: project.assignment,
      agile: project.agile,
    },
    team: team?.name ?? null,
    recordTypes,
    ...(sla ? { sla } : {}),
    automation,
  });
  if (project.inbound) warnings.push("The inbound email address is not part of a template; set one after installing");
  return { definition, warnings: [...new Set(warnings)] };
}
