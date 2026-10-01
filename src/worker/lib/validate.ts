import { z } from "zod";
import { invalid } from "./errors.ts";
import { isUuid } from "./crypto.ts";

/** Parse input with a zod schema; failures become a 422 with one issue per field. */
export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw invalid(r.error.issues.map((i) => ({ field: i.path.join(".") || "body", message: i.message })));
  return r.data;
}

/**
 * Parse a partial update. Zod keeps defaults inside .partial() schemas, so only the keys the
 * caller actually sent are returned: an omitted field never resets to its default.
 */
export function parsePatch<T extends Record<string, unknown>>(schema: z.ZodType<T>, input: unknown): Partial<T> {
  const data = parse(schema, input);
  const sent = input && typeof input === "object" ? new Set(Object.keys(input)) : new Set<string>();
  return Object.fromEntries(Object.entries(data).filter(([k]) => sent.has(k))) as Partial<T>;
}

/** A UUID, normalized to lower case so comparisons with database values hold. */
export const uuid = z
  .string()
  .refine(isUuid, "Must be an id")
  .transform((v) => v.toLowerCase());

export const configKey = z.string().regex(/^[a-z][a-z0-9_]{0,40}$/, "Lowercase letters, digits and underscores");

/** Split a comma-separated query value into a bounded list. */
export function listParam(raw: string | undefined, max = 50): string[] | undefined {
  if (!raw) return undefined;
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items.slice(0, max) : undefined;
}
