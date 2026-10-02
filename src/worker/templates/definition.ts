// The template format: one project's configuration as data, without any records or people.
// Built-in templates, "Save as template", the setup wizard and uploaded template files all use
// it, and one installer turns it into ordinary configuration.
//
// What it cannot carry, it leaves as placeholders filled in at install time:
//   approvals    "$approvers" — the people chosen at install (default: the installing admin)
//   SLA policies businessHours — counted on the calendar chosen at install
//   the team     a team NAME — found or created at install
import { z } from "zod";
import { configKey } from "../lib/validate.ts";

export const TEMPLATE_FORMAT = "tend247-template";
export const TEMPLATE_VERSION = 1;

const key = z.string().regex(/^[a-z][a-z0-9_]{0,40}$/, "Lowercase letters, digits and underscores");
const priorities = z.array(z.enum(["low", "medium", "high", "urgent"])).max(4);

export const templateFieldSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, "Lowercase letters, digits and underscores"),
  label: z.string().trim().min(1).max(200),
  type: z.enum(["text", "long_text", "number", "currency", "date", "select", "multi_select", "user", "checkbox", "url"]),
  required: z.boolean().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  helpText: z.string().max(1000).optional(),
  defaultValue: z.unknown().optional(),
});

const transitionSchema = z.object({
  key: configKey,
  name: z.string().trim().min(1).max(60),
  from: z.array(configKey).max(50).default([]),
  to: configKey,
  roles: z.array(z.enum(["admin", "agent", "requester"])).min(1).optional(),
  requiredFields: z.array(z.string().min(1).max(80)).max(30).optional(),
  approval: z.object({ mode: z.enum(["any", "sequential"]), approvers: z.tuple([z.literal("$approvers")]) }).optional(),
  actions: z
    .array(
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("assign_self") }),
        z.object({ type: z.literal("unassign") }),
        z.object({ type: z.literal("set_field"), field: z.string().min(1).max(80), value: z.unknown() }),
      ]),
    )
    .max(10)
    .optional(),
});

const formSchema = z.object({ sections: z.array(z.object({ title: z.string().max(80), fields: z.array(z.string().min(1).max(80)).max(60) })).min(1).max(20) });

export const templateRecordTypeSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, "Lowercase letters, digits and underscores"),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(5000).default(""),
  isEpic: z.boolean().default(false),
  fields: z.array(templateFieldSchema).max(60).default([]),
  workflow: z.object({
    initial: configKey,
    statuses: z.array(z.object({ key: configKey, name: z.string().trim().min(1).max(60), category: z.enum(["todo", "in_progress", "done"]) })).min(1).max(50),
    transitions: z.array(transitionSchema).max(100),
  }),
  layout: z.object({ create: formSchema, view: formSchema, requiredOnCreate: z.array(z.string().min(1).max(80)).max(60).default([]) }).optional(),
});

const automationSchema = z.object({
  name: z.string().trim().min(1).max(200),
  enabled: z.boolean().default(true),
  trigger: z.string().min(1).max(40),
  conditions: z.array(z.record(z.string(), z.unknown())).max(20).default([]),
  /** As in automation rules, except create_linked names its record type by key (recordTypeKey). */
  actions: z.array(z.record(z.string(), z.unknown())).min(1).max(10),
});

export const templateSchema = z
  .object({
    format: z.literal(TEMPLATE_FORMAT),
    version: z.number().int().min(1).max(TEMPLATE_VERSION),
    name: z.string().trim().min(1).max(120),
    summary: z.string().max(500).default(""),
    project: z.object({
      key: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/, "2–10 capital letters or digits, starting with a letter"),
      name: z.string().trim().min(1).max(200),
      description: z.string().max(5000).default(""),
      restricted: z.boolean().default(false),
      requesterAccess: z.boolean().default(true),
      assignment: z.enum(["manual", "round_robin"]).default("manual"),
      agile: z.boolean().default(false),
    }),
    /** Team that owns the queue: found by name or created at install. */
    team: z.string().trim().min(1).max(120).nullable().default(null),
    recordTypes: z.array(templateRecordTypeSchema).min(1).max(20),
    sla: z
      .object({
        policies: z
          .array(
            z.object({
              name: z.string().trim().min(1).max(100),
              priorities: priorities.default([]),
              /** Record type keys this policy covers; empty = all. */
              recordTypes: z.array(key).max(20).default([]),
              firstResponseMinutes: z.number().int().min(1).max(525_600).nullable().default(null),
              resolutionMinutes: z.number().int().min(1).max(525_600).nullable().default(null),
              businessHours: z.boolean().default(true),
              warnPercent: z.number().int().min(1).max(99).default(80),
            }),
          )
          .max(20),
        pauseStatuses: z.array(configKey).max(50).default([]),
      })
      .optional(),
    automation: z.array(automationSchema).max(30).default([]),
  })
  .superRefine((t, ctx) => {
    const keys = t.recordTypes.map((r) => r.key);
    keys.forEach((k, i) => {
      if (keys.indexOf(k) !== i) ctx.addIssue({ code: "custom", path: ["recordTypes", i, "key"], message: `Record type key "${k}" appears twice` });
    });
    // A template never calls out: webhook actions (whose URLs can carry secrets, or send records
    // somewhere the installing admin did not choose) are added after installing, on purpose.
    t.automation.forEach((rule, i) =>
      rule.actions.forEach((a, j) => {
        if (a.type === "webhook") ctx.addIssue({ code: "custom", path: ["automation", i, "actions", j], message: "Templates cannot contain webhook actions; add webhooks after installing" });
      }),
    );
    t.sla?.policies.forEach((p, i) =>
      p.recordTypes.forEach((k, j) => {
        if (!keys.includes(k)) ctx.addIssue({ code: "custom", path: ["sla", "policies", i, "recordTypes", j], message: `Unknown record type "${k}"` });
      }),
    );
  });

export type TemplateDefinition = z.output<typeof templateSchema>;
export type TemplateInput = z.input<typeof templateSchema>;

/** What a picker shows about a template. */
export function summarize(def: TemplateDefinition) {
  const first = def.recordTypes.find((r) => !r.isEpic) ?? def.recordTypes[0]!;
  return {
    name: def.name,
    summary: def.summary,
    projectKey: def.project.key,
    restricted: def.project.restricted,
    agile: def.project.agile,
    recordTypes: def.recordTypes.map((r) => r.name),
    recordType: first.name,
    fields: first.fields.map((f) => f.label),
    statuses: first.workflow.statuses.map((s) => s.name),
    approvals: def.recordTypes.some((r) => r.workflow.transitions.some((tr) => tr.approval)),
    sla: Boolean(def.sla?.policies.length),
    automation: def.automation.length,
  };
}
