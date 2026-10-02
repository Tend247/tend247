// Who can see a record. Admins see everything. Agents see every record in open projects; in
// a restricted project (HR, finance) only records of teams they belong to, plus records
// assigned to or requested by them. Requesters see only their own requests.
import type { Tx } from "../db/client.ts";
import type { Actor } from "../audit.ts";
import { UUID_RE } from "../lib/crypto.ts";
import type { Priority } from "./constants.ts";

export interface RecordRow {
  id: string;
  /** Creation order (bigint as text); used for pagination. */
  seq: string;
  key: string;
  number: number;
  projectId: string;
  recordTypeId: string;
  title: string;
  description: string;
  status: string;
  statusCategory: "todo" | "in_progress" | "done";
  priority: Priority;
  assigneeId: string | null;
  assigneeName: string | null;
  requesterId: string | null;
  requesterName: string | null;
  teamId: string | null;
  teamName: string | null;
  custom: Record<string, unknown>;
  version: number;
  workflowVersion: number | null;
  pendingApprovalId: string | null;
  firstRespondedAt: Date | null;
  resolvedAt: Date | null;
  via: "app" | "email" | "automation" | "api" | "import";
  /** Agile projects: estimate, sprint, epic and backlog position. */
  storyPoints: number | null;
  sprintId: string | null;
  epicId: string | null;
  epicKey: string | null;
  epicTitle: string | null;
  rank: number | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  deletedBy: string | null;
}

/**
 * Columns of a record. With an actor, the epic's key and title appear only when that person
 * could open the epic themselves (same rule as visibleTo, applied to the epic row).
 */
export const RECORD_COLUMNS = (tx: Tx, actor?: Actor) => tx`
  records.id, records.seq::text as seq, records.key, records.number, records.project_id, records.record_type_id,
  records.title, records.description, records.status, records.status_category, records.priority,
  records.assignee_id, (select display_name from users where id = records.assignee_id) as assignee_name,
  records.requester_id, (select display_name from users where id = records.requester_id) as requester_name,
  records.team_id, (select name from teams where id = records.team_id) as team_name,
  records.custom, records.version, records.workflow_version, records.pending_approval_id,
  records.first_responded_at, records.resolved_at, records.via, records.created_by, records.created_at,
  records.updated_at, records.deleted_at, records.deleted_by,
  records.story_points::float8 as story_points, records.sprint_id, records.epic_id, records.rank,
  (select e.key from records e where e.id = records.epic_id and e.deleted_at is null and ${epicVisibleTo(tx, actor)}) as epic_key,
  (select e.title from records e where e.id = records.epic_id and e.deleted_at is null and ${epicVisibleTo(tx, actor)}) as epic_title`;

function epicVisibleTo(tx: Tx, actor?: Actor) {
  if (!actor || actor.role === "admin") return tx`true`;
  if (actor.role === "requester") return tx`e.requester_id = ${actor.userId}`;
  return tx`(
    not exists (select 1 from projects ep where ep.id = e.project_id and ep.restricted)
    or e.assignee_id = ${actor.userId}
    or e.requester_id = ${actor.userId}
    or exists (
      select 1 from team_members em
      where em.user_id = ${actor.userId}
        and (em.team_id = e.team_id or em.team_id = (select ep2.default_team_id from projects ep2 where ep2.id = e.project_id))
    ))`;
}

/** SQL condition (over the `records` table) for the records an actor may see. */
export function visibleTo(tx: Tx, actor: Actor) {
  if (actor.role === "admin") return tx`true`;
  if (actor.role === "requester") return tx`records.requester_id = ${actor.userId}`;
  return tx`(
    not exists (select 1 from projects vp where vp.id = records.project_id and vp.restricted)
    or records.assignee_id = ${actor.userId}
    or records.requester_id = ${actor.userId}
    or exists (
      select 1 from team_members vm
      where vm.user_id = ${actor.userId}
        and (vm.team_id = records.team_id
             or vm.team_id = (select vp2.default_team_id from projects vp2 where vp2.id = records.project_id))
    ))`;
}

/** Load a record the actor can see, by id or key; null if missing or not visible. */
export async function loadRecord(
  tx: Tx,
  actor: Actor,
  idOrKey: string,
  opts: { includeDeleted?: boolean; lock?: boolean } = {},
): Promise<RecordRow | null> {
  const where = UUID_RE.test(idOrKey) ? tx`records.id = ${idOrKey.toLowerCase()}` : tx`records.key = ${idOrKey.toUpperCase()}`;
  const [r] = await tx<RecordRow[]>`
    select ${RECORD_COLUMNS(tx, actor)} from records
    where ${where} and ${visibleTo(tx, actor)} ${opts.includeDeleted ? tx`` : tx`and records.deleted_at is null`}
    ${opts.lock ? tx`for update of records` : tx``}`;
  return r ?? null;
}
