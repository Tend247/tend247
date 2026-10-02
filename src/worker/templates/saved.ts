// A workspace's own templates: saved from a project, built in the setup wizard, or uploaded
// from a file another workspace downloaded.
import { z } from "zod";
import type { Tx } from "../db/client.ts";
import { audit, type Actor } from "../audit.ts";
import { AppError, notFound } from "../lib/errors.ts";
import { isUuid } from "../lib/crypto.ts";
import { parse } from "../lib/validate.ts";
import { summarize, type TemplateDefinition } from "./definition.ts";
import { parseDefinition } from "./install.ts";

const MAX_SAVED = 100;

export interface SavedTemplate {
  id: string;
  name: string;
  summary: string;
  source: "saved" | "wizard" | "file";
  createdAt: Date;
  updatedAt: Date;
  createdByName: string | null;
}

const metaSchema = z.object({
  name: z.string().trim().min(1).max(120),
  summary: z.string().trim().max(500).optional(),
  /** Replace a saved template with the same name instead of refusing. */
  replace: z.boolean().default(false),
});

export async function listSaved(tx: Tx) {
  const rows = await tx<(SavedTemplate & { definition: unknown })[]>`
    select t.id, t.name, t.summary, t.source, t.created_at, t.updated_at, u.display_name as created_by_name, t.definition
    from workspace_templates t left join users u on u.id = t.created_by order by t.name`;
  return rows.map(({ definition, ...t }) => {
    try {
      return { ...t, key: t.id, ...summarize(parseDefinition(definition)), name: t.name, summary: t.summary, valid: true };
    } catch {
      return { ...t, key: t.id, valid: false };
    }
  });
}

export async function getSaved(tx: Tx, id: string): Promise<{ id: string; name: string; definition: TemplateDefinition }> {
  if (!isUuid(id)) throw notFound("Template");
  const [row] = await tx<{ id: string; name: string; definition: unknown }[]>`select id, name, definition from workspace_templates where id = ${id}`;
  if (!row) throw notFound("Template");
  return { id: row.id, name: row.name, definition: parseDefinition(row.definition) };
}

export async function saveTemplate(
  tx: Tx,
  actor: Actor,
  definition: TemplateDefinition,
  input: unknown,
  source: SavedTemplate["source"],
): Promise<SavedTemplate> {
  const meta = parse(metaSchema, input);
  const def: TemplateDefinition = { ...definition, name: meta.name, summary: meta.summary ?? definition.summary };
  const [existing] = await tx<{ id: string }[]>`select id from workspace_templates where name = ${meta.name}`;
  if (existing && !meta.replace) {
    throw new AppError("conflict", `A saved template called "${meta.name}" already exists`, { templateId: existing.id });
  }
  let id: string;
  if (existing) {
    await tx`
      update workspace_templates set definition = ${tx.json(def as never)}, summary = ${def.summary}, source = ${source}, updated_at = now()
      where id = ${existing.id}`;
    id = existing.id;
  } else {
    const [n] = await tx<{ n: number }[]>`select count(*)::int as n from workspace_templates`;
    if ((n?.n ?? 0) >= MAX_SAVED) throw new AppError("conflict", `A workspace can keep up to ${MAX_SAVED} saved templates; delete one first`);
    const [row] = await tx<{ id: string }[]>`
      insert into workspace_templates (tenant_id, name, summary, definition, source, created_by)
      values (${actor.tenantId}, ${meta.name}, ${def.summary}, ${tx.json(def as never)}, ${source}, ${actor.userId})
      returning id`;
    id = row!.id;
  }
  await audit(tx, actor, { entity: "template", entityId: id, action: existing ? "replace" : "save", after: { name: meta.name, source } });
  const [saved] = await tx<SavedTemplate[]>`
    select t.id, t.name, t.summary, t.source, t.created_at, t.updated_at, u.display_name as created_by_name
    from workspace_templates t left join users u on u.id = t.created_by where t.id = ${id}`;
  return saved!;
}

export async function deleteSaved(tx: Tx, actor: Actor, id: string): Promise<void> {
  // No validation: a template that no longer passes the checks must still be removable.
  if (!isUuid(id)) throw notFound("Template");
  const [t] = await tx<{ id: string; name: string }[]>`select id, name from workspace_templates where id = ${id}`;
  if (!t) throw notFound("Template");
  await tx`delete from workspace_templates where id = ${t.id}`;
  await audit(tx, actor, { entity: "template", entityId: t.id, action: "delete", before: { name: t.name } });
}
