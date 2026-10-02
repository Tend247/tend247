// The setup wizard's working state, and the conversions to and from the template format the
// server installs (src/worker/templates/definition.ts). The wizard offers simple patterns
// (any-to-any steps for boards, or one step after another); a template with hand-made
// transitions keeps them ("custom") while its statuses and rules stay editable.
import type { Category, FieldType, Layout, Priority } from "../../../types.ts";

export interface TemplateTransition {
  key: string;
  name: string;
  from: string[];
  to: string;
  roles?: ("admin" | "agent" | "requester")[];
  requiredFields?: string[];
  approval?: { mode: "any" | "sequential"; approvers: ["$approvers"] };
  actions?: ({ type: "assign_self" } | { type: "unassign" } | { type: "set_field"; field: string; value: unknown })[];
}

export interface TemplateDefinition {
  format: "tend247-template";
  version: 1;
  name: string;
  summary: string;
  project: { key: string; name: string; description: string; restricted: boolean; requesterAccess: boolean; assignment: "manual" | "round_robin"; agile: boolean };
  team: string | null;
  recordTypes: {
    key: string;
    name: string;
    description: string;
    isEpic: boolean;
    fields: { key: string; label: string; type: FieldType; required?: boolean; options?: Record<string, unknown>; helpText?: string; defaultValue?: unknown }[];
    workflow: { initial: string; statuses: { key: string; name: string; category: Category }[]; transitions: TemplateTransition[] };
    layout?: Layout;
  }[];
  sla?: {
    policies: { name: string; priorities: Priority[]; recordTypes: string[]; firstResponseMinutes: number | null; resolutionMinutes: number | null; businessHours: boolean; warnPercent?: number }[];
    pauseStatuses: string[];
  };
  automation: Record<string, unknown>[];
}

export interface WField {
  uid: string;
  key: string;
  /** Imported keys stay put; a new field's key follows its label. */
  locked: boolean;
  label: string;
  type: FieldType;
  required: boolean;
  /** Choices, one per line (choice fields). */
  choices: string;
  currency: string;
  helpText: string;
  /** Options the wizard does not edit (e.g. maxLength), kept as they came. */
  extra: Record<string, unknown>;
  defaultValue?: unknown;
}

export interface WStatus {
  uid: string;
  key: string;
  locked: boolean;
  name: string;
  category: Category;
}

export interface WRule {
  approval: boolean;
  required: string[];
}

export type Flow = "free" | "ordered" | "custom";

export interface WType {
  uid: string;
  key: string;
  locked: boolean;
  name: string;
  description: string;
  isEpic: boolean;
  fields: WField[];
  statuses: WStatus[];
  flow: Flow;
  /** Hand-made transitions from a template (flow "custom"). */
  custom: TemplateTransition[];
  /** What happens when something moves INTO a status, keyed by status key. */
  rules: Record<string, WRule>;
  /** Assign the record to whoever moves it into the first in-progress status. */
  assignOnStart: boolean;
  /** Requesters may reopen a finished request. */
  requesterReopen: boolean;
  layout?: Layout;
}

export type Unit = "minutes" | "hours" | "days";

export interface WPolicy {
  uid: string;
  name: string;
  priorities: Priority[];
  /** Record type keys; empty means every type. */
  recordTypes: string[];
  firstResponse: { value: string; unit: Unit };
  resolution: { value: string; unit: Unit };
  businessHours: boolean;
  warnPercent: number;
}

export interface WizardState {
  name: string;
  summary: string;
  project: { name: string; key: string; description: string; restricted: boolean; requesterAccess: boolean; assignment: "manual" | "round_robin"; agile: boolean };
  /** Has the admin typed the key themselves? (Otherwise it follows the name.) */
  keyEdited: boolean;
  team: string;
  /** Every non-epic type uses the first type's steps. */
  sharedSteps: boolean;
  types: WType[];
  sla: { enabled: boolean; policies: WPolicy[]; pauseStatuses: string[] };
  automation: Record<string, unknown>[];
}

let counter = 0;
export const uid = () => `u${Date.now().toString(36)}${(counter++).toString(36)}`;

export const FIELD_TYPES: { type: FieldType; label: string; hint: string }[] = [
  { type: "text", label: "Short text", hint: "A name, a reference number" },
  { type: "long_text", label: "Long text", hint: "Notes, steps, an explanation" },
  { type: "select", label: "One choice", hint: "Pick one from a list" },
  { type: "multi_select", label: "Several choices", hint: "Pick any from a list" },
  { type: "number", label: "Number", hint: "A count or quantity" },
  { type: "currency", label: "Money", hint: "An amount in a currency" },
  { type: "date", label: "Date", hint: "A due date, a start date" },
  { type: "user", label: "Person", hint: "Someone in the workspace" },
  { type: "checkbox", label: "Yes / no", hint: "A tick box" },
  { type: "url", label: "Web address", hint: "A link" },
];

export const CATEGORY_LABELS: Record<Category, string> = { todo: "Not started", in_progress: "In progress", done: "Finished" };
export const BUILTIN_REQUIRABLE: { key: string; label: string }[] = [
  { key: "description", label: "Description" },
  { key: "assigneeId", label: "Assignee" },
  { key: "teamId", label: "Team" },
];
const LAYOUT_BUILTINS = ["description", "priority", "assigneeId", "teamId"];

/** "Invoice number" → "invoice_number" (a valid field, type or status key). */
export function slug(label: string, fallback = "item"): string {
  const s = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40)
    .replace(/_+$/, "");
  if (!s) return fallback;
  return /^[a-z]/.test(s) ? s : `${fallback}_${s}`.slice(0, 40);
}

export function uniqueKey(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) {
    const k = `${base.slice(0, 37)}_${i}`;
    if (!taken.includes(k)) return k;
  }
}

/** "Facilities Requests" → "FR"; "Facilities" → "FAC". */
export function projectKeyFrom(name: string): string {
  const words = name
    .toUpperCase()
    .normalize("NFKD")
    .replace(/[^A-Z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  let key = words.length >= 2 ? words.map((w) => w[0]).join("") : (words[0] ?? "").slice(0, 3);
  key = key.replace(/^[0-9]+/, "").slice(0, 6);
  return key.length >= 2 ? key : (key + "XX").slice(0, 2);
}

export function newField(type: FieldType, taken: string[]): WField {
  const label = FIELD_TYPES.find((f) => f.type === type)!.label;
  return {
    uid: uid(),
    key: uniqueKey(slug(label, "field"), taken),
    locked: false,
    label,
    type,
    required: false,
    choices: type === "select" || type === "multi_select" ? "Option one\nOption two" : "",
    currency: "USD",
    helpText: "",
    extra: {},
  };
}

export function status(name: string, category: Category): WStatus {
  return { uid: uid(), key: slug(name, "status"), locked: false, name, category };
}

export function newType(name: string, opts: Partial<WType> = {}): WType {
  return {
    uid: uid(),
    key: slug(name, "type"),
    locked: false,
    name,
    description: "",
    isEpic: false,
    fields: [],
    statuses: [status("New", "todo"), status("In progress", "in_progress"), status("Done", "done")],
    flow: "ordered",
    custom: [],
    rules: {},
    assignOnStart: true,
    requesterReopen: true,
    ...opts,
  };
}

export function blankState(): WizardState {
  return {
    name: "",
    summary: "",
    project: { name: "", key: "", description: "", restricted: false, requesterAccess: true, assignment: "manual", agile: false },
    keyEdited: false,
    team: "",
    sharedSteps: true,
    types: [newType("Request")],
    sla: { enabled: false, policies: [], pauseStatuses: [] },
    automation: [],
  };
}

/** Types for a software team: stories, bugs and tasks on a board, grouped by epics. */
export function agileTypes(): WType[] {
  const steps = () => [status("To do", "todo"), status("In progress", "in_progress"), status("In review", "in_progress"), status("Done", "done")];
  return [
    newType("Story", { statuses: steps(), flow: "free", requesterReopen: false }),
    newType("Bug", { statuses: steps(), flow: "free", requesterReopen: false, fields: [{ ...newField("select", []), key: "severity", label: "Severity", choices: "Minor\nMajor\nCritical", required: true, locked: true }] }),
    newType("Task", { statuses: steps(), flow: "free", requesterReopen: false }),
    newType("Epic", { isEpic: true, statuses: [status("Open", "todo"), status("In progress", "in_progress"), status("Done", "done")], flow: "free", assignOnStart: false, requesterReopen: false }),
  ];
}

// ---------------------------------------------------------------- minutes and units

const unitMinutes = (unit: Unit, businessHours: boolean) => (unit === "minutes" ? 1 : unit === "hours" ? 60 : businessHours ? 8 * 60 : 24 * 60);

export function toMinutes(v: { value: string; unit: Unit }, businessHours: boolean): number | null {
  const n = Number(v.value);
  if (!v.value.trim() || !Number.isFinite(n) || n <= 0) return null;
  return Math.max(1, Math.round(n * unitMinutes(v.unit, businessHours)));
}

export function fromMinutes(m: number | null, businessHours: boolean): { value: string; unit: Unit } {
  if (!m) return { value: "", unit: "hours" };
  const day = unitMinutes("days", businessHours);
  if (m % day === 0) return { value: String(m / day), unit: "days" };
  if (m % 60 === 0) return { value: String(m / 60), unit: "hours" };
  return { value: String(m), unit: "minutes" };
}

// ---------------------------------------------------------------- transitions

/** The statuses, flow and rules a type uses (its own, or the shared first type's). */
export function stepsOf(state: WizardState, t: WType): WType {
  if (!state.sharedSteps || t.isEpic) return t;
  return state.types.find((x) => !x.isEpic) ?? t;
}

const verb = (s: WStatus) => (s.category === "done" ? s.name : `Move to ${s.name}`).slice(0, 60);

export function buildTransitions(steps: WType, fieldKeys: string[]): TemplateTransition[] {
  const keys = steps.statuses.map((s) => s.key);
  const known = new Set([...fieldKeys, ...BUILTIN_REQUIRABLE.map((b) => b.key)]);
  const firstWork = steps.statuses.find((s) => s.category === "in_progress");
  const open = steps.statuses.filter((s) => s.category !== "done");
  const done = steps.statuses.filter((s) => s.category === "done");
  let base: TemplateTransition[] = [];
  if (steps.flow === "free") {
    base = steps.statuses.map((s) => ({ key: `to_${s.key}`.slice(0, 41), name: verb(s), from: [], to: s.key }));
  } else if (steps.flow === "ordered") {
    for (let i = 0; i < open.length - 1; i++) {
      base.push({ key: `to_${open[i + 1]!.key}`.slice(0, 41), name: verb(open[i + 1]!), from: [open[i]!.key], to: open[i + 1]!.key });
    }
    for (const d of done) base.push({ key: `to_${d.key}`.slice(0, 41), name: verb(d), from: open.map((s) => s.key), to: d.key });
    const back = firstWork ?? open[0];
    if (back && done.length) {
      base.push({
        key: uniqueKey("reopen", base.map((b) => b.key)),
        name: "Reopen",
        from: done.map((d) => d.key),
        to: back.key,
        ...(steps.requesterReopen ? { roles: ["admin", "agent", "requester"] as ("admin" | "agent" | "requester")[] } : {}),
      });
    }
  } else {
    const covered = new Set<string>();
    for (const tr of steps.custom) {
      if (!keys.includes(tr.to)) continue;
      const from = tr.from.filter((f) => keys.includes(f));
      if (tr.from.length && !from.length) continue;
      base.push({ ...tr, from });
      covered.add(tr.to);
    }
    // A status added in the wizard can be reached from anywhere.
    for (const s of steps.statuses) {
      if (!covered.has(s.key) && s.key !== steps.statuses[0]?.key) {
        base.push({ key: uniqueKey(`to_${s.key}`.slice(0, 41), base.map((b) => b.key)), name: verb(s), from: [], to: s.key });
      }
    }
  }
  return base.map((tr) => {
    const rule = steps.rules[tr.to];
    const others = (tr.actions ?? []).filter((a) => a.type !== "assign_self");
    const assign = steps.assignOnStart && firstWork && tr.to === firstWork.key ? [{ type: "assign_self" as const }] : [];
    const required = (rule?.required ?? tr.requiredFields ?? []).filter((k) => known.has(k));
    const out: TemplateTransition = { key: tr.key, name: tr.name, from: tr.from, to: tr.to };
    if (tr.roles) out.roles = tr.roles;
    if (required.length) out.requiredFields = required;
    if (rule ? rule.approval : tr.approval) out.approval = { mode: tr.approval?.mode ?? "any", approvers: ["$approvers"] };
    if (others.length || assign.length) out.actions = [...others, ...assign];
    return out;
  });
}

// ---------------------------------------------------------------- to and from the template format

function fieldOut(f: WField) {
  const options: Record<string, unknown> = { ...f.extra };
  if (f.type === "select" || f.type === "multi_select") {
    const labels = [...new Set(f.choices.split("\n").map((s) => s.trim()).filter(Boolean))];
    const used: string[] = [];
    options.choices = labels.map((label) => {
      const value = uniqueKey(slug(label, "option"), used);
      used.push(value);
      return { value, label };
    });
  }
  if (f.type === "currency") options.currency = f.currency.toUpperCase();
  return {
    key: f.key,
    label: f.label,
    type: f.type,
    ...(f.required ? { required: true } : {}),
    ...(Object.keys(options).length ? { options } : {}),
    ...(f.helpText ? { helpText: f.helpText } : {}),
    ...(f.defaultValue !== undefined ? { defaultValue: f.defaultValue } : {}),
  };
}

/** Keep a template's form layout in step with the fields: drop removed ones, add new ones. */
function fixLayout(layout: Layout | undefined, fieldKeys: string[]): Layout | undefined {
  if (!layout) return undefined;
  const known = new Set([...LAYOUT_BUILTINS, ...fieldKeys]);
  const clean = (sections: Layout["create"]["sections"]) => sections.map((s) => ({ ...s, fields: s.fields.filter((f) => known.has(f)) })).filter((s) => s.fields.length);
  const create = clean(layout.create.sections);
  const view = clean(layout.view.sections);
  const onForm = new Set(create.flatMap((s) => s.fields));
  const inView = new Set(view.flatMap((s) => s.fields));
  const missingCreate = fieldKeys.filter((k) => !onForm.has(k));
  const missingView = fieldKeys.filter((k) => !inView.has(k));
  if (!create.length) create.push({ title: "", fields: ["description"] });
  if (!view.length) view.push({ title: "Details", fields: ["priority", "assigneeId"] });
  create[create.length - 1]!.fields.push(...missingCreate);
  view[0]!.fields.push(...missingView);
  return { create: { sections: create }, view: { sections: view }, requiredOnCreate: layout.requiredOnCreate.filter((k) => known.has(k)) };
}

export function toDefinition(state: WizardState): TemplateDefinition {
  const def: TemplateDefinition = {
    format: "tend247-template",
    version: 1,
    name: (state.name || state.project.name || "Untitled").slice(0, 120),
    summary: state.summary.slice(0, 500),
    project: { ...state.project, key: state.project.key.toUpperCase() },
    team: state.team.trim() || null,
    recordTypes: state.types.map((t) => {
      const steps = stepsOf(state, t);
      const fields = t.fields.map(fieldOut);
      const fieldKeys = fields.map((f) => f.key);
      return {
        key: t.key,
        name: t.name,
        description: t.description,
        isEpic: state.project.agile && t.isEpic,
        fields,
        workflow: {
          initial: steps.statuses[0]?.key ?? "new",
          statuses: steps.statuses.map(({ key, name, category }) => ({ key, name, category })),
          transitions: buildTransitions(steps, fieldKeys),
        },
        ...(t.layout ? { layout: fixLayout(t.layout, fieldKeys) } : {}),
      };
    }),
    automation: state.automation,
  };
  if (state.sla.enabled && state.sla.policies.length) {
    const typeKeys = state.types.map((t) => t.key);
    const statusKeys = new Set(state.types.flatMap((t) => stepsOf(state, t).statuses.map((s) => s.key)));
    def.sla = {
      policies: state.sla.policies.map((p) => ({
        name: p.name,
        priorities: p.priorities,
        recordTypes: p.recordTypes.filter((k) => typeKeys.includes(k)),
        firstResponseMinutes: toMinutes(p.firstResponse, p.businessHours),
        resolutionMinutes: toMinutes(p.resolution, p.businessHours),
        businessHours: p.businessHours,
        warnPercent: p.warnPercent,
      })),
      pauseStatuses: state.sla.pauseStatuses.filter((k) => statusKeys.has(k)),
    };
  }
  return def;
}

/** Recognise a pattern the wizard can edit; anything else stays "custom". */
function detectFlow(statuses: WStatus[], transitions: TemplateTransition[]): Flow {
  const free = statuses.every((s) => transitions.some((t) => t.to === s.key && t.from.length === 0)) && transitions.every((t) => t.from.length === 0);
  return free ? "free" : "custom";
}

export function fromDefinition(def: TemplateDefinition): WizardState {
  const types: WType[] = def.recordTypes.map((rt) => {
    const statuses = rt.workflow.statuses.map((s) => ({ uid: uid(), locked: true, ...s }));
    // The initial status leads the list (the wizard starts records in the first status).
    const i = statuses.findIndex((s) => s.key === rt.workflow.initial);
    if (i > 0) statuses.unshift(...statuses.splice(i, 1));
    const rules: Record<string, WRule> = {};
    for (const s of statuses) {
      const into = rt.workflow.transitions.filter((t) => t.to === s.key);
      if (!into.length) continue;
      rules[s.key] = { approval: into.some((t) => t.approval), required: [...new Set(into.flatMap((t) => t.requiredFields ?? []))] };
    }
    const firstWork = statuses.find((s) => s.category === "in_progress");
    return {
      uid: uid(),
      key: rt.key,
      locked: true,
      name: rt.name,
      description: rt.description ?? "",
      isEpic: Boolean(rt.isEpic),
      fields: rt.fields.map((f) => {
        const { choices, currency, ...extra } = (f.options ?? {}) as { choices?: { label: string }[]; currency?: string };
        return {
          uid: uid(),
          key: f.key,
          locked: true,
          label: f.label,
          type: f.type,
          required: Boolean(f.required),
          choices: (choices ?? []).map((c) => c.label).join("\n"),
          currency: currency ?? "USD",
          helpText: f.helpText ?? "",
          extra,
          ...(f.defaultValue !== undefined ? { defaultValue: f.defaultValue } : {}),
        };
      }),
      statuses,
      flow: detectFlow(statuses, rt.workflow.transitions),
      custom: rt.workflow.transitions,
      rules,
      assignOnStart: Boolean(firstWork && rt.workflow.transitions.some((t) => t.to === firstWork.key && t.actions?.some((a) => a.type === "assign_self"))),
      requesterReopen: rt.workflow.transitions.some((t) => t.roles?.includes("requester")),
      ...(rt.layout ? { layout: rt.layout } : {}),
    };
  });
  // Shared steps when every non-epic type has the same statuses and transitions.
  const work = def.recordTypes.filter((r) => !r.isEpic);
  const same = work.length > 1 && work.every((r) => JSON.stringify(r.workflow) === JSON.stringify(work[0]!.workflow));
  const anyBusiness = def.sla?.policies.some((p) => p.businessHours) ?? false;
  return {
    name: def.name,
    summary: def.summary ?? "",
    project: {
      name: def.project.name,
      key: def.project.key,
      description: def.project.description ?? "",
      restricted: Boolean(def.project.restricted),
      requesterAccess: def.project.requesterAccess ?? true,
      assignment: def.project.assignment ?? "manual",
      agile: Boolean(def.project.agile),
    },
    keyEdited: true,
    team: def.team ?? "",
    sharedSteps: same || work.length <= 1,
    types,
    sla: {
      enabled: Boolean(def.sla?.policies.length),
      policies: (def.sla?.policies ?? []).map((p) => ({
        uid: uid(),
        name: p.name,
        priorities: p.priorities ?? [],
        recordTypes: p.recordTypes ?? [],
        firstResponse: fromMinutes(p.firstResponseMinutes, p.businessHours ?? anyBusiness),
        resolution: fromMinutes(p.resolutionMinutes, p.businessHours ?? anyBusiness),
        businessHours: p.businessHours ?? true,
        warnPercent: p.warnPercent ?? 80,
      })),
      pauseStatuses: def.sla?.pauseStatuses ?? [],
    },
    automation: def.automation ?? [],
  };
}

/** Which wizard step a server problem belongs to, from its field path. */
export function stepForIssue(field: string): number {
  if (field === "projectKey" || field.startsWith("project")) return 1;
  if (/^recordTypes\.\d+\.(workflow|layout)/.test(field)) return 3;
  if (field.startsWith("recordTypes")) return 2;
  if (field.startsWith("sla")) return 4;
  return 5;
}

export function newPolicy(name = "Standard"): WPolicy {
  return {
    uid: uid(),
    name,
    priorities: [],
    recordTypes: [],
    firstResponse: { value: "4", unit: "hours" },
    resolution: { value: "3", unit: "days" },
    businessHours: true,
    warnPercent: 80,
  };
}
