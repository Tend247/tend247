// Custom field types: how admins define them, and how record values are validated.
// Values are stored in records.custom (jsonb) keyed by the field key.
import { z } from "zod";
import type { FieldIssue } from "../lib/errors.ts";
import { isUuid } from "../lib/crypto.ts";

export const FIELD_TYPES = [
  "text",
  "long_text",
  "number",
  "currency",
  "date",
  "select",
  "multi_select",
  "user",
  "checkbox",
  "url",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface Choice {
  value: string;
  label: string;
}

export interface FieldOptions {
  maxLength?: number;
  min?: number;
  max?: number;
  integer?: boolean;
  currency?: string;
  choices?: Choice[];
}

export interface FieldDef {
  id: string;
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  options: FieldOptions;
  defaultValue: unknown;
  helpText: string;
  position: number;
  archivedAt: Date | null;
}

const choiceSchema = z.object({
  value: z.string().trim().min(1).max(100),
  label: z.string().trim().min(1).max(200),
});

const optionsByType: Record<FieldType, z.ZodType<FieldOptions>> = {
  text: z.object({ maxLength: z.number().int().min(1).max(2000).optional() }).strict(),
  long_text: z.object({ maxLength: z.number().int().min(1).max(100_000).optional() }).strict(),
  number: z
    .object({ min: z.number().optional(), max: z.number().optional(), integer: z.boolean().optional() })
    .strict()
    .refine((o) => o.min === undefined || o.max === undefined || o.min <= o.max, "min must not exceed max"),
  currency: z.object({ currency: z.string().regex(/^[A-Z]{3}$/, "Use an ISO 4217 code such as USD") }).strict(),
  date: z.object({}).strict(),
  select: z
    .object({ choices: z.array(choiceSchema).min(1).max(500) })
    .strict()
    .refine((o) => new Set(o.choices.map((c) => c.value)).size === o.choices.length, "Choice values must be unique"),
  multi_select: z
    .object({ choices: z.array(choiceSchema).min(1).max(500) })
    .strict()
    .refine((o) => new Set(o.choices.map((c) => c.value)).size === o.choices.length, "Choice values must be unique"),
  user: z.object({}).strict(),
  checkbox: z.object({}).strict(),
  url: z.object({}).strict(),
};

export const fieldKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,62}$/, "Use lowercase letters, digits and underscores, starting with a letter");

export const newFieldSchema = z.object({
  key: fieldKeySchema,
  label: z.string().trim().min(1).max(200),
  type: z.enum(FIELD_TYPES),
  required: z.boolean().default(false),
  options: z.record(z.string(), z.unknown()).default({}),
  defaultValue: z.unknown().optional(),
  helpText: z.string().max(1000).default(""),
  position: z.number().int().min(0).max(10_000).optional(),
});

export const fieldPatchSchema = z
  .object({
    label: z.string().trim().min(1).max(200),
    required: z.boolean(),
    options: z.record(z.string(), z.unknown()),
    defaultValue: z.unknown(),
    helpText: z.string().max(1000),
    position: z.number().int().min(0).max(10_000),
    archived: z.boolean(),
  })
  .partial()
  .strict();

/** Validate type-specific options; returns issues prefixed with `options`. */
export function validateOptions(type: FieldType, options: unknown): { options: FieldOptions; issues: FieldIssue[] } {
  const parsed = optionsByType[type].safeParse(options ?? {});
  if (parsed.success) return { options: parsed.data, issues: [] };
  return {
    options: {},
    issues: parsed.error.issues.map((i) => ({
      field: ["options", ...i.path.map(String)].join("."),
      message: i.message,
    })),
  };
}

export type CoerceResult = { ok: true; value: unknown } | { ok: false; message: string };

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Validate and normalise one non-null value for a field. */
export function coerceValue(def: Pick<FieldDef, "type" | "options">, value: unknown): CoerceResult {
  const o = def.options;
  switch (def.type) {
    case "text":
    case "long_text": {
      if (typeof value !== "string") return { ok: false, message: "Must be text" };
      const max = o.maxLength ?? (def.type === "text" ? 500 : 20_000);
      const v = def.type === "text" ? value.trim() : value;
      if (v.length > max) return { ok: false, message: `Must be at most ${max} characters` };
      return { ok: true, value: v };
    }
    case "number": {
      const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
      if (typeof n !== "number" || !Number.isFinite(n)) return { ok: false, message: "Must be a number" };
      if (o.integer && !Number.isInteger(n)) return { ok: false, message: "Must be a whole number" };
      if (o.min !== undefined && n < o.min) return { ok: false, message: `Must be at least ${o.min}` };
      if (o.max !== undefined && n > o.max) return { ok: false, message: `Must be at most ${o.max}` };
      return { ok: true, value: n };
    }
    case "currency": {
      const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
      if (typeof n !== "number" || !Number.isFinite(n)) return { ok: false, message: "Must be an amount" };
      if (Math.abs(n) >= 1e13) return { ok: false, message: "Amount is too large" };
      if (Math.round(n * 100) / 100 !== n) return { ok: false, message: "Use at most two decimal places" };
      return { ok: true, value: n };
    }
    case "date": {
      if (typeof value !== "string") return { ok: false, message: "Must be a date (YYYY-MM-DD)" };
      const m = DATE_RE.exec(value);
      if (!m) return { ok: false, message: "Must be a date (YYYY-MM-DD)" };
      const d = new Date(`${value}T00:00:00Z`);
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
        return { ok: false, message: "Not a real calendar date" };
      }
      return { ok: true, value };
    }
    case "select": {
      if (typeof value !== "string") return { ok: false, message: "Pick one of the options" };
      if (!(o.choices ?? []).some((c) => c.value === value)) return { ok: false, message: "Not one of the options" };
      return { ok: true, value };
    }
    case "multi_select": {
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
        return { ok: false, message: "Pick zero or more of the options" };
      }
      const allowed = new Set((o.choices ?? []).map((c) => c.value));
      const bad = value.find((v) => !allowed.has(v));
      if (bad !== undefined) return { ok: false, message: `"${bad}" is not one of the options` };
      return { ok: true, value: [...new Set(value)] };
    }
    case "user":
      if (!isUuid(value)) return { ok: false, message: "Must be a person" };
      return { ok: true, value: value.toLowerCase() };
    case "checkbox":
      if (typeof value !== "boolean") return { ok: false, message: "Must be true or false" };
      return { ok: true, value };
    case "url": {
      if (typeof value !== "string" || value.length > 2000) return { ok: false, message: "Must be a web address" };
      try {
        const u = new URL(value.trim());
        if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, message: "Use an http(s) address" };
        return { ok: true, value: u.toString() };
      } catch {
        return { ok: false, message: "Must be a web address" };
      }
    }
  }
}

export interface CustomValidation {
  values: Record<string, unknown>;
  issues: FieldIssue[];
  /** User ids referenced by `user` fields; the caller confirms they exist in the workspace. */
  userRefs: { field: string; id: string }[];
}

/**
 * Validate custom values against a record type's field definitions.
 * - create: applies defaults and enforces required fields.
 * - update: `input` is a partial patch merged over `existing`; null clears a value.
 */
export function validateCustom(
  defs: FieldDef[],
  input: Record<string, unknown> | undefined,
  mode: "create" | "update",
  existing: Record<string, unknown> = {},
): CustomValidation {
  const issues: FieldIssue[] = [];
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const values: Record<string, unknown> = mode === "update" ? { ...existing } : {};
  const patch = input ?? {};

  for (const [key, raw] of Object.entries(patch)) {
    const def = byKey.get(key);
    const path = `custom.${key}`;
    if (!def) {
      issues.push({ field: path, message: "Unknown field" });
      continue;
    }
    if (def.archivedAt) {
      issues.push({ field: path, message: "This field is archived and can no longer be changed" });
      continue;
    }
    if (raw === null || raw === "" || (Array.isArray(raw) && raw.length === 0 && def.required)) {
      if (def.required) issues.push({ field: path, message: "Required" });
      else delete values[key];
      continue;
    }
    const r = coerceValue(def, raw);
    if (!r.ok) {
      issues.push({ field: path, message: r.message });
    } else if (typeof r.value === "string" && r.value.trim() === "") {
      // Whitespace-only text counts as empty.
      if (def.required) issues.push({ field: path, message: "Required" });
      else delete values[key];
    } else {
      values[key] = r.value;
    }
  }

  if (mode === "create") {
    for (const def of defs) {
      if (def.archivedAt || has(values, def.key) || has(patch, def.key)) continue;
      if (def.defaultValue !== null && def.defaultValue !== undefined) {
        const r = coerceValue(def, def.defaultValue);
        if (r.ok) values[def.key] = r.value;
      } else if (def.required) {
        issues.push({ field: `custom.${def.key}`, message: "Required" });
      }
    }
  }

  const userRefs: { field: string; id: string }[] = [];
  for (const def of defs) {
    if (def.type === "user" && typeof values[def.key] === "string" && has(patch, def.key)) {
      userRefs.push({ field: `custom.${def.key}`, id: values[def.key] as string });
    }
  }
  return { values, issues, userRefs };
}

function has(obj: Record<string, unknown>, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, k);
}
