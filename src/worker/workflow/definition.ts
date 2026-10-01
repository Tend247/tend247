// Workflow definitions: a record type's statuses (each in a category) and the transitions
// between them. Stored as versioned JSON in config_versions; validated here.
import { z } from "zod";
import { configKey, uuid } from "../lib/validate.ts";
import type { FieldIssue } from "../lib/errors.ts";
import type { Role } from "../audit.ts";

export const CATEGORIES = ["todo", "in_progress", "done"] as const;
export type StatusCategory = (typeof CATEGORIES)[number];

/** Built-in record fields a transition can require or a post-transition action can set. */
export const BUILTIN_FIELDS = ["description", "assigneeId", "teamId", "priority"] as const;

const statusSchema = z.object({
  key: configKey,
  name: z.string().trim().min(1).max(60),
  category: z.enum(CATEGORIES),
});

const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("assign_self") }),
  z.object({ type: z.literal("unassign") }),
  z.object({ type: z.literal("set_field"), field: z.string().min(1).max(80), value: z.unknown() }),
]);

const approvalSchema = z.object({
  mode: z.enum(["any", "sequential"]),
  approvers: z.array(uuid).min(1).max(10),
});

const transitionSchema = z.object({
  key: configKey,
  name: z.string().trim().min(1).max(60),
  /** Statuses this transition starts from; empty means any status. */
  from: z.array(configKey).max(50).default([]),
  to: configKey,
  /** Who may run it. Defaults to staff; add "requester" for e.g. a requester reopening. */
  roles: z.array(z.enum(["admin", "agent", "requester"])).min(1).default(["admin", "agent"]),
  /** Fields that must have a value (after any values sent with the transition). */
  requiredFields: z.array(z.string().min(1).max(80)).max(30).default([]),
  approval: approvalSchema.optional(),
  /** Changes applied after the transition. */
  actions: z.array(actionSchema).max(10).default([]),
});

export const workflowSchema = z.object({
  initial: configKey,
  statuses: z.array(statusSchema).min(1).max(50),
  transitions: z.array(transitionSchema).max(100).default([]),
});

export type WorkflowStatus = z.infer<typeof statusSchema>;
export type WorkflowTransition = z.infer<typeof transitionSchema>;
export type WorkflowAction = z.infer<typeof actionSchema>;
export type WorkflowDefinition = z.infer<typeof workflowSchema>;

export const DEFAULT_WORKFLOW: WorkflowDefinition = {
  initial: "new",
  statuses: [
    { key: "new", name: "New", category: "todo" },
    { key: "in_progress", name: "In progress", category: "in_progress" },
    { key: "waiting", name: "Waiting", category: "in_progress" },
    { key: "done", name: "Done", category: "done" },
  ],
  transitions: [
    { key: "start", name: "Start work", from: ["new"], to: "in_progress", roles: ["admin", "agent"], requiredFields: [], actions: [] },
    { key: "wait", name: "Wait for reply", from: ["new", "in_progress"], to: "waiting", roles: ["admin", "agent"], requiredFields: [], actions: [] },
    { key: "resume", name: "Resume", from: ["waiting"], to: "in_progress", roles: ["admin", "agent"], requiredFields: [], actions: [] },
    { key: "resolve", name: "Resolve", from: ["new", "in_progress", "waiting"], to: "done", roles: ["admin", "agent"], requiredFields: [], actions: [] },
    { key: "reopen", name: "Reopen", from: ["done"], to: "in_progress", roles: ["admin", "agent", "requester"], requiredFields: [], actions: [] },
  ],
};

/**
 * Structural checks that need no database: unique keys, references between statuses and
 * transitions. Field and approver references are checked against the workspace on publish.
 */
export function checkWorkflow(def: WorkflowDefinition, fieldKeys: string[]): FieldIssue[] {
  const issues: FieldIssue[] = [];
  const statusKeys = new Set<string>();
  def.statuses.forEach((s, i) => {
    if (statusKeys.has(s.key)) issues.push({ field: `statuses.${i}.key`, message: `Duplicate status "${s.key}"` });
    statusKeys.add(s.key);
  });
  if (!statusKeys.has(def.initial)) issues.push({ field: "initial", message: "Must be one of the statuses" });
  const known = new Set<string>([...BUILTIN_FIELDS, ...fieldKeys]);
  const transitionKeys = new Set<string>();
  def.transitions.forEach((t, i) => {
    if (transitionKeys.has(t.key)) issues.push({ field: `transitions.${i}.key`, message: `Duplicate transition "${t.key}"` });
    transitionKeys.add(t.key);
    if (!statusKeys.has(t.to)) issues.push({ field: `transitions.${i}.to`, message: `Unknown status "${t.to}"` });
    t.from.forEach((f, j) => {
      if (!statusKeys.has(f)) issues.push({ field: `transitions.${i}.from.${j}`, message: `Unknown status "${f}"` });
    });
    t.requiredFields.forEach((f, j) => {
      if (!known.has(f)) issues.push({ field: `transitions.${i}.requiredFields.${j}`, message: `Unknown field "${f}"` });
    });
    t.actions.forEach((a, j) => {
      if (a.type === "set_field" && !known.has(a.field)) {
        issues.push({ field: `transitions.${i}.actions.${j}.field`, message: `Unknown field "${a.field}"` });
      }
    });
  });
  return issues;
}

export function statusOf(def: WorkflowDefinition, key: string): WorkflowStatus | undefined {
  return def.statuses.find((s) => s.key === key);
}

/** Transitions available from a status for a role (approval-gated ones included). */
export function availableTransitions(def: WorkflowDefinition, status: string, role: Role): WorkflowTransition[] {
  return def.transitions.filter(
    (t) => (t.from.length === 0 || t.from.includes(status)) && t.to !== status && t.roles.includes(role),
  );
}
