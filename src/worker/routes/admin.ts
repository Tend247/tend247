import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Ctx } from "../http.ts";
import { actorOf, readJson, requireRole } from "../http.ts";
import { withTenant, type Tx } from "../db/client.ts";
import { audit, type Actor } from "../audit.ts";
import {
  createField,
  createProject,
  createRecordType,
  listAudit,
  listFields,
  listProjects,
  updateField,
  updateProject,
  updateRecordType,
} from "../config/service.ts";
import {
  assertKind,
  discardDraft,
  getConfigBundle,
  getVersion,
  publishDraft,
  restoreVersion,
  saveDraft,
} from "../config/versions.ts";
import { createUser, listUsers, updateUser } from "../users/service.ts";
import { createTeam, listTeams, updateTeam } from "../teams/service.ts";
import { getSettings, updateSettings } from "../settings/service.ts";
import { createRule, deleteRule, listRules, updateRule } from "../automation/service.ts";
import { calendarSchema } from "../sla/calendar.ts";
import { backupHealth } from "../backup/export.ts";
import { webhookSecret } from "../jobs/webhooks.ts";
import { notFound } from "../lib/errors.ts";
import { isUuid } from "../lib/crypto.ts";
import { parse, parsePatch } from "../lib/validate.ts";

function asAdmin<T>(c: Ctx, fn: (tx: Tx, actor: Actor) => Promise<T>): Promise<T> {
  const auth = requireRole(c, "admin");
  return withTenant(c.get("sql"), auth.tenantId, (tx) => fn(tx, actorOf(auth)));
}

function ownerParam(c: Ctx): string {
  const id = c.req.param("ownerId") ?? "";
  if (!isUuid(id)) throw notFound("Configuration");
  return id.toLowerCase();
}

const calendarPatch = calendarSchema.partial().strict();

/** Workspace configuration. Every route requires the admin role. */
export const adminRoutes = new Hono<AppEnv>()
  .use(async (c, next) => {
    requireRole(c, "admin");
    await next();
  })

  // ---------------------------------------------------------------- people and teams
  .get("/users", async (c) => c.json({ users: await asAdmin(c, (tx) => listUsers(tx, { includeInactive: true })) }))
  .post("/users", async (c) => {
    const body = await readJson(c);
    return c.json({ user: await asAdmin(c, (tx, actor) => createUser(tx, actor, body)) }, 201);
  })
  .patch("/users/:id", async (c) => {
    const body = await readJson(c);
    return c.json({ user: await asAdmin(c, (tx, actor) => updateUser(tx, actor, c.req.param("id"), body)) });
  })

  .get("/teams", async (c) => c.json({ teams: await asAdmin(c, (tx) => listTeams(tx, { includeArchived: true })) }))
  .post("/teams", async (c) => {
    const body = await readJson(c);
    return c.json({ team: await asAdmin(c, (tx, actor) => createTeam(tx, actor, body)) }, 201);
  })
  .patch("/teams/:id", async (c) => {
    const body = await readJson(c);
    return c.json({ team: await asAdmin(c, (tx, actor) => updateTeam(tx, actor, c.req.param("id"), body)) });
  })

  // ---------------------------------------------------------------- projects, types, fields
  .get("/projects", async (c) => c.json({ projects: await asAdmin(c, (tx) => listProjects(tx, { includeArchived: true })) }))
  .post("/projects", async (c) => {
    const body = await readJson(c);
    return c.json({ project: await asAdmin(c, (tx, actor) => createProject(tx, actor, body)) }, 201);
  })
  .patch("/projects/:id", async (c) => {
    const body = await readJson(c);
    return c.json({ project: await asAdmin(c, (tx, actor) => updateProject(tx, actor, c.req.param("id"), body)) });
  })
  .post("/projects/:id/record-types", async (c) => {
    const body = await readJson(c);
    const recordType = await asAdmin(c, (tx, actor) => createRecordType(tx, actor, c.req.param("id"), body));
    return c.json({ recordType }, 201);
  })
  .patch("/record-types/:id", async (c) => {
    const body = await readJson(c);
    return c.json({ recordType: await asAdmin(c, (tx, actor) => updateRecordType(tx, actor, c.req.param("id"), body)) });
  })
  .get("/record-types/:id/fields", async (c) => {
    const includeArchived = c.req.query("includeArchived") === "true";
    return c.json({ fields: await asAdmin(c, (tx) => listFields(tx, c.req.param("id"), { includeArchived })) });
  })
  .post("/record-types/:id/fields", async (c) => {
    const body = await readJson(c);
    return c.json({ field: await asAdmin(c, (tx, actor) => createField(tx, actor, c.req.param("id"), body)) }, 201);
  })
  .patch("/fields/:id", async (c) => {
    const body = await readJson(c);
    return c.json({ field: await asAdmin(c, (tx, actor) => updateField(tx, actor, c.req.param("id"), body)) });
  })

  // ---------------------------------------------------------------- versioned config
  // :kind is workflow or layout (owner = record type) or sla (owner = project).
  .get("/config/:kind/:ownerId", async (c) => {
    const kind = assertKind(c.req.param("kind"));
    return c.json(await asAdmin(c, (tx) => getConfigBundle(tx, kind, ownerParam(c))));
  })
  .get("/config/:kind/:ownerId/versions/:version", async (c) => {
    const kind = assertKind(c.req.param("kind"));
    const version = Number(c.req.param("version"));
    if (!Number.isInteger(version) || version < 1) throw notFound("Version");
    return c.json({ version: await asAdmin(c, (tx) => getVersion(tx, kind, ownerParam(c), version)) });
  })
  .put("/config/:kind/:ownerId/draft", async (c) => {
    const kind = assertKind(c.req.param("kind"));
    const body = (await readJson(c)) as { definition?: unknown };
    return c.json({ draft: await asAdmin(c, (tx, actor) => saveDraft(tx, actor, kind, ownerParam(c), body?.definition)) });
  })
  .delete("/config/:kind/:ownerId/draft", async (c) => {
    const kind = assertKind(c.req.param("kind"));
    await asAdmin(c, (tx, actor) => discardDraft(tx, actor, kind, ownerParam(c)));
    return c.json({ ok: true });
  })
  .post("/config/:kind/:ownerId/publish", async (c) => {
    const kind = assertKind(c.req.param("kind"));
    const body = await readJson(c);
    return c.json({ published: await asAdmin(c, (tx, actor) => publishDraft(tx, actor, kind, ownerParam(c), body)) });
  })
  .post("/config/:kind/:ownerId/versions/:version/restore", async (c) => {
    const kind = assertKind(c.req.param("kind"));
    const version = Number(c.req.param("version"));
    if (!Number.isInteger(version) || version < 1) throw notFound("Version");
    const body = await readJson(c);
    return c.json({ published: await asAdmin(c, (tx, actor) => restoreVersion(tx, actor, kind, ownerParam(c), version, body)) });
  })

  // ---------------------------------------------------------------- business-hours calendars
  .get("/calendars", async (c) =>
    c.json({ calendars: await asAdmin(c, (tx) => tx`select id, name, timezone, hours, holidays from calendars order by name`) }),
  )
  .post("/calendars", async (c) => {
    const data = parse(calendarSchema, await readJson(c));
    const calendar = await asAdmin(c, async (tx, actor) => {
      const [row] = await tx`
        insert into calendars (tenant_id, name, timezone, hours, holidays)
        values (${actor.tenantId}, ${data.name}, ${data.timezone}, ${tx.json(data.hours as never)}, ${tx.json(data.holidays)})
        returning id, name, timezone, hours, holidays`;
      await audit(tx, actor, { entity: "calendar", entityId: row!.id as string, action: "create", after: row });
      return row;
    });
    return c.json({ calendar }, 201);
  })
  .patch("/calendars/:id", async (c) => {
    const patch = parsePatch(calendarPatch, await readJson(c));
    const calendar = await asAdmin(c, async (tx, actor) => {
      if (!isUuid(c.req.param("id"))) throw notFound("Calendar");
      const [before] = await tx`select id, name, timezone, hours, holidays from calendars where id = ${c.req.param("id")}`;
      if (!before) throw notFound("Calendar");
      const next = parse(calendarSchema, { ...before, ...patch });
      const [after] = await tx`
        update calendars set name = ${next.name}, timezone = ${next.timezone}, hours = ${tx.json(next.hours as never)},
          holidays = ${tx.json(next.holidays)}
        where id = ${before.id as string} returning id, name, timezone, hours, holidays`;
      await audit(tx, actor, { entity: "calendar", entityId: before.id as string, action: "update", before, after });
      return after;
    });
    return c.json({ calendar });
  })

  // ---------------------------------------------------------------- automation
  .get("/automation", async (c) => c.json({ rules: await asAdmin(c, (tx) => listRules(tx)) }))
  .post("/automation", async (c) => {
    const body = await readJson(c);
    const allowHttp = c.get("deps").config.devLogin;
    return c.json({ rule: await asAdmin(c, (tx, actor) => createRule(tx, actor, body, { allowHttp })) }, 201);
  })
  .patch("/automation/:id", async (c) => {
    const body = await readJson(c);
    const allowHttp = c.get("deps").config.devLogin;
    return c.json({ rule: await asAdmin(c, (tx, actor) => updateRule(tx, actor, c.req.param("id"), body, { allowHttp })) });
  })
  .delete("/automation/:id", async (c) => {
    await asAdmin(c, (tx, actor) => deleteRule(tx, actor, c.req.param("id")));
    return c.json({ ok: true });
  })
  /** The secret receivers use to verify X-Tend-Signature. */
  .get("/webhook-secret", async (c) => c.json({ secret: await asAdmin(c, (tx, actor) => webhookSecret(tx, actor.tenantId)) }))
  .post("/webhook-secret/rotate", async (c) => {
    const secret = await asAdmin(c, async (tx, actor) => {
      const s = await webhookSecret(tx, actor.tenantId, true);
      await audit(tx, actor, { entity: "webhook_secret", entityId: actor.tenantId, action: "rotate" });
      return s;
    });
    return c.json({ secret });
  })
  .get("/webhook-deliveries", async (c) =>
    c.json({
      deliveries: await asAdmin(c, (tx) => tx`
        select id, rule_id, url, status, attempts, last_status, last_error, created_at, delivered_at
        from webhook_deliveries order by created_at desc limit 100`),
    }),
  )

  // ---------------------------------------------------------------- workspace
  .get("/settings", async (c) => {
    const auth = requireRole(c, "admin");
    return c.json({ settings: await getSettings(c.get("sql"), auth.tenantId) });
  })
  .patch("/settings", async (c) => {
    const body = await readJson(c);
    return c.json({ settings: await asAdmin(c, (tx, actor) => updateSettings(tx, actor, body)) });
  })
  .get("/backups", async (c) => {
    const { backups, config } = c.get("deps");
    return c.json(
      await asAdmin(c, (tx, actor) => backupHealth(tx, actor.tenantId, Boolean(backups), Boolean(config.backup.encryptionKey))),
    );
  })
  .get("/email", async (c) => {
    const { config, email } = c.get("deps");
    return c.json({ provider: email.name, canDeliver: email.canDeliver, from: config.email.from, inboundDomain: config.email.inboundDomain });
  })

  .get("/audit", async (c) => {
    const q = parse(z.object({ limit: z.coerce.number().int().optional(), before: z.coerce.number().int().optional() }), c.req.query());
    return c.json({ entries: await asAdmin(c, (tx) => listAudit(tx, { limit: q.limit ?? 50, before: q.before })) });
  });
