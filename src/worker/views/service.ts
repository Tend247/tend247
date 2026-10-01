// Saved views (a filter, sort and list/board mode) and record links.
import { z } from "zod";
import type { Tx } from "../db/client.ts";
import { isStaff, type Actor } from "../audit.ts";
import { AppError, forbidden, notFound } from "../lib/errors.ts";
import { isUuid } from "../lib/crypto.ts";
import { parse, parsePatch } from "../lib/validate.ts";
import { loadRecord } from "../records/access.ts";
import { recordEvent } from "../records/service.ts";

// ---------------------------------------------------------------- saved views

const filterValue = z.union([z.string().max(500), z.array(z.string().max(100)).max(50), z.record(z.string(), z.unknown())]);

const viewSchema = z.object({
  name: z.string().trim().min(1).max(120),
  shared: z.boolean().default(false),
  definition: z
    .object({
      filters: z.record(z.string().max(40), filterValue).default({}),
      sort: z.string().max(40).optional(),
      mode: z.enum(["list", "board"]).default("list"),
      columns: z.array(z.string().max(80)).max(30).optional(),
    })
    .strict(),
});
const viewPatchSchema = viewSchema.partial().strict();

export interface SavedView {
  id: string;
  ownerId: string;
  ownerName: string | null;
  name: string;
  shared: boolean;
  definition: z.infer<typeof viewSchema>["definition"];
  createdAt: Date;
  updatedAt: Date;
}

const COLUMNS = (tx: Tx) => tx`v.id, v.owner_id, u.display_name as owner_name, v.name, v.shared, v.definition, v.created_at, v.updated_at`;

export async function listViews(tx: Tx, actor: Actor): Promise<SavedView[]> {
  return tx<SavedView[]>`
    select ${COLUMNS(tx)} from saved_views v left join users u on u.id = v.owner_id
    where v.owner_id = ${actor.userId} or (v.shared and ${isStaff(actor)})
    order by v.shared, v.name`;
}

async function loadView(tx: Tx, actor: Actor, id: string): Promise<SavedView> {
  if (!isUuid(id)) throw notFound("View");
  const [v] = await tx<SavedView[]>`select ${COLUMNS(tx)} from saved_views v left join users u on u.id = v.owner_id where v.id = ${id}`;
  if (!v || (v.ownerId !== actor.userId && !(v.shared && isStaff(actor)))) throw notFound("View");
  return v;
}

export async function createView(tx: Tx, actor: Actor, input: unknown): Promise<SavedView> {
  if (!actor.userId) throw forbidden();
  const data = parse(viewSchema, input);
  if (data.shared && !isStaff(actor)) throw forbidden("Only staff can share views");
  const [row] = await tx<{ id: string }[]>`
    insert into saved_views (tenant_id, owner_id, name, shared, definition)
    values (${actor.tenantId}, ${actor.userId}, ${data.name}, ${data.shared}, ${tx.json(data.definition as never)})
    returning id`;
  return loadView(tx, actor, row!.id);
}

export async function updateView(tx: Tx, actor: Actor, id: string, input: unknown): Promise<SavedView> {
  const patch = parsePatch(viewPatchSchema, input);
  const v = await loadView(tx, actor, id);
  // Shared views can be changed by their owner or an admin.
  if (v.ownerId !== actor.userId && actor.role !== "admin") throw forbidden("Only the owner or an admin can change this view");
  if (patch.shared && !isStaff(actor)) throw forbidden("Only staff can share views");
  await tx`
    update saved_views set name = ${patch.name ?? v.name}, shared = ${patch.shared ?? v.shared},
      definition = ${tx.json((patch.definition ?? v.definition) as never)}, updated_at = now()
    where id = ${v.id}`;
  return loadView(tx, actor, v.id);
}

export async function deleteView(tx: Tx, actor: Actor, id: string): Promise<void> {
  const v = await loadView(tx, actor, id);
  if (v.ownerId !== actor.userId && actor.role !== "admin") throw forbidden("Only the owner or an admin can delete this view");
  await tx`delete from saved_views where id = ${v.id}`;
}

// ---------------------------------------------------------------- links

export const LINK_KINDS = ["relates", "blocks", "duplicates", "parent"] as const;

const linkSchema = z.object({ to: z.string().min(1).max(40), kind: z.enum(LINK_KINDS) }).strict();

export interface RecordLink {
  id: string;
  kind: (typeof LINK_KINDS)[number];
  /** "outward": this record → other (e.g. this blocks other); "inward": other → this. */
  direction: "outward" | "inward";
  other: { id: string; key: string; title: string; status: string; statusCategory: string };
}

export async function listLinks(tx: Tx, actor: Actor, recordIdOrKey: string): Promise<RecordLink[]> {
  const record = await loadRecord(tx, actor, recordIdOrKey);
  if (!record) throw notFound("Record");
  const rows = await tx<{ id: string; kind: RecordLink["kind"]; fromId: string; toId: string }[]>`
    select id, kind, from_id, to_id from record_links where from_id = ${record.id} or to_id = ${record.id} order by created_at`;
  const out: RecordLink[] = [];
  for (const l of rows) {
    const otherId = l.fromId === record.id ? l.toId : l.fromId;
    const other = await loadRecord(tx, actor, otherId);
    if (!other) continue; // Links never reveal records the viewer cannot see.
    out.push({
      id: l.id,
      kind: l.kind,
      direction: l.fromId === record.id ? "outward" : "inward",
      other: { id: other.id, key: other.key, title: other.title, status: other.status, statusCategory: other.statusCategory },
    });
  }
  return out;
}

export async function createLink(tx: Tx, actor: Actor, recordIdOrKey: string, input: unknown): Promise<RecordLink> {
  if (!isStaff(actor)) throw forbidden("Requesters cannot link records");
  const data = parse(linkSchema, input);
  const from = await loadRecord(tx, actor, recordIdOrKey);
  const to = await loadRecord(tx, actor, data.to);
  if (!from) throw notFound("Record");
  if (!to) throw notFound("Linked record");
  if (from.id === to.id) throw new AppError("bad_request", "A record cannot link to itself");
  const [row] = await tx<{ id: string }[]>`
    insert into record_links (tenant_id, from_id, to_id, kind, created_by)
    values (${actor.tenantId}, ${from.id}, ${to.id}, ${data.kind}, ${actor.userId})
    returning id`;
  await recordEvent(tx, actor, from.id, "linked", { linkId: row!.id, kind: data.kind, to: to.key });
  await recordEvent(tx, actor, to.id, "linked", { linkId: row!.id, kind: data.kind, from: from.key });
  return {
    id: row!.id,
    kind: data.kind,
    direction: "outward",
    other: { id: to.id, key: to.key, title: to.title, status: to.status, statusCategory: to.statusCategory },
  };
}

export async function deleteLink(tx: Tx, actor: Actor, id: string): Promise<void> {
  if (!isStaff(actor)) throw forbidden("Requesters cannot unlink records");
  if (!isUuid(id)) throw notFound("Link");
  const [l] = await tx<{ fromId: string; toId: string; kind: string }[]>`select from_id, to_id, kind from record_links where id = ${id}`;
  if (!l) throw notFound("Link");
  const from = await loadRecord(tx, actor, l.fromId);
  const to = await loadRecord(tx, actor, l.toId);
  if (!from || !to) throw notFound("Link");
  await tx`delete from record_links where id = ${id}`;
  await recordEvent(tx, actor, from.id, "unlinked", { kind: l.kind, to: to.key });
  await recordEvent(tx, actor, to.id, "unlinked", { kind: l.kind, from: from.key });
}
