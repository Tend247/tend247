// Teams own queues. A project's default team receives its new records; with round-robin
// assignment each new record goes to the next active member in turn.
import { z } from "zod";
import type { Tx } from "../db/client.ts";
import { audit, type Actor } from "../audit.ts";
import { invalid, notFound } from "../lib/errors.ts";
import { parse, uuid } from "../lib/validate.ts";

export interface Team {
  id: string;
  name: string;
  archivedAt: Date | null;
  members: { id: string; displayName: string; email: string; role: string; active: boolean }[];
}

const teamSchema = z.object({ name: z.string().trim().min(1).max(120), memberIds: z.array(uuid).max(500).default([]) });
const teamPatchSchema = z
  .object({ name: z.string().trim().min(1).max(120), memberIds: z.array(uuid).max(500), archived: z.boolean() })
  .partial()
  .strict();

export async function listTeams(tx: Tx, opts: { includeArchived?: boolean } = {}): Promise<Team[]> {
  return tx<Team[]>`
    select t.id, t.name, t.archived_at,
      coalesce((
        select jsonb_agg(jsonb_build_object('id', u.id, 'displayName', u.display_name, 'email', u.email,
                                            'role', u.role, 'active', u.active) order by u.display_name)
        from team_members m join users u on u.id = m.user_id where m.team_id = t.id
      ), '[]'::jsonb) as members
    from teams t
    where ${opts.includeArchived ? tx`true` : tx`t.archived_at is null`}
    order by t.name`;
}

export async function getTeam(tx: Tx, id: string): Promise<Team> {
  const team = (await listTeams(tx, { includeArchived: true })).find((t) => t.id === id);
  if (!team) throw notFound("Team");
  return team;
}

async function setMembers(tx: Tx, actor: Actor, teamId: string, memberIds: string[]): Promise<void> {
  const ids = [...new Set(memberIds)];
  if (ids.length) {
    const staff = await tx<{ id: string }[]>`
      select id from users where role in ('admin', 'agent')
        and id in (select (jsonb_array_elements_text(${tx.json(ids)}))::uuid)`;
    const ok = new Set(staff.map((u) => u.id));
    const bad = ids.findIndex((id) => !ok.has(id));
    if (bad >= 0) throw invalid([{ field: `memberIds.${bad}`, message: "Team members must be admins or agents" }]);
  }
  await tx`delete from team_members where team_id = ${teamId}`;
  if (ids.length) {
    await tx`
      insert into team_members (tenant_id, team_id, user_id)
      select ${actor.tenantId}, ${teamId}, (id)::uuid from jsonb_array_elements_text(${tx.json(ids)}) as id`;
  }
}

export async function createTeam(tx: Tx, actor: Actor, input: unknown): Promise<Team> {
  const data = parse(teamSchema, input);
  const [row] = await tx<{ id: string }[]>`
    insert into teams (tenant_id, name) values (${actor.tenantId}, ${data.name}) returning id`;
  await setMembers(tx, actor, row!.id, data.memberIds);
  const team = await getTeam(tx, row!.id);
  await audit(tx, actor, { entity: "team", entityId: team.id, action: "create", after: team });
  return team;
}

export async function updateTeam(tx: Tx, actor: Actor, id: string, input: unknown): Promise<Team> {
  const patch = parse(teamPatchSchema, input);
  const before = await getTeam(tx, id);
  const archivedAt = patch.archived === undefined ? before.archivedAt : patch.archived ? new Date() : null;
  await tx`update teams set name = ${patch.name ?? before.name}, archived_at = ${archivedAt} where id = ${id}`;
  if (patch.memberIds) await setMembers(tx, actor, id, patch.memberIds);
  const after = await getTeam(tx, id);
  await audit(tx, actor, { entity: "team", entityId: id, action: "update", before, after });
  return after;
}

/** Ids of the teams a person belongs to. */
export async function teamsOf(tx: Tx, userId: string): Promise<string[]> {
  const rows = await tx<{ teamId: string }[]>`select team_id from team_members where user_id = ${userId}`;
  return rows.map((r) => r.teamId);
}

/**
 * The next active member of a team in round-robin order (by display name, then id), or null
 * when the team has no active members. The team row is locked so concurrent records do not
 * land on the same person.
 */
export async function nextRoundRobin(tx: Tx, teamId: string): Promise<string | null> {
  const [team] = await tx<{ rrLastUserId: string | null }[]>`
    select rr_last_user_id from teams where id = ${teamId} and archived_at is null for update`;
  if (!team) return null;
  const members = await tx<{ id: string }[]>`
    select u.id from team_members m join users u on u.id = m.user_id
    where m.team_id = ${teamId} and u.active and u.role in ('admin', 'agent')
    order by u.display_name, u.id`;
  if (!members.length) return null;
  const last = members.findIndex((m) => m.id === team.rrLastUserId);
  const next = members[(last + 1) % members.length]!.id;
  await tx`update teams set rr_last_user_id = ${next} where id = ${teamId}`;
  return next;
}
