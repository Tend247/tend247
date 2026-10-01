// Layouts: which fields a record type's forms show, in what order and sections, and which are
// required when creating. The create form is also the boundary for requesters: they can set
// only the fields it shows.
import { z } from "zod";
import type { FieldIssue } from "../lib/errors.ts";
import type { FieldDef } from "../config/fields.ts";

/** Built-in fields a layout may place (title is always shown first). */
export const LAYOUT_BUILTINS = ["description", "priority", "assigneeId", "teamId"] as const;

const sectionSchema = z.object({
  title: z.string().trim().max(80).default(""),
  fields: z.array(z.string().min(1).max(80)).max(60),
});

const formSchema = z.object({ sections: z.array(sectionSchema).min(1).max(20) });

export const layoutSchema = z.object({
  create: formSchema,
  view: formSchema,
  /** Fields required on the create form, in addition to fields marked required. */
  requiredOnCreate: z.array(z.string().min(1).max(80)).max(60).default([]),
});

export type LayoutDefinition = z.infer<typeof layoutSchema>;

/** The layout used until an admin publishes one: every active field, in field order. */
export function defaultLayout(fields: Pick<FieldDef, "key" | "archivedAt">[]): LayoutDefinition {
  const custom = fields.filter((f) => !f.archivedAt).map((f) => f.key);
  return {
    create: { sections: [{ title: "", fields: ["description", "priority", ...custom] }] },
    view: { sections: [{ title: "Details", fields: ["priority", "assigneeId", "teamId", ...custom] }] },
    requiredOnCreate: [],
  };
}

export function checkLayout(def: LayoutDefinition, fieldKeys: string[]): FieldIssue[] {
  const issues: FieldIssue[] = [];
  const known = new Set<string>([...LAYOUT_BUILTINS, ...fieldKeys]);
  for (const form of ["create", "view"] as const) {
    const seen = new Set<string>();
    def[form].sections.forEach((s, i) =>
      s.fields.forEach((f, j) => {
        if (!known.has(f)) issues.push({ field: `${form}.sections.${i}.fields.${j}`, message: `Unknown field "${f}"` });
        else if (seen.has(f)) issues.push({ field: `${form}.sections.${i}.fields.${j}`, message: `"${f}" appears twice` });
        seen.add(f);
      }),
    );
  }
  const onCreate = new Set(def.create.sections.flatMap((s) => s.fields));
  def.requiredOnCreate.forEach((f, i) => {
    if (!onCreate.has(f)) issues.push({ field: `requiredOnCreate.${i}`, message: `"${f}" is not on the create form` });
  });
  return issues;
}

export function createFormFields(def: LayoutDefinition): Set<string> {
  return new Set(def.create.sections.flatMap((s) => s.fields));
}
