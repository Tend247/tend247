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
import { getTemplate, templateSummaries } from "../templates/catalog.ts";
import { checkDefinition, installDefinition, installTemplate, parseDefinition } from "../templates/install.ts";
import { summarize } from "../templates/definition.ts";
import { projectToDefinition } from "../templates/export.ts";
import { deleteSaved, getSaved, listSaved, saveTemplate } from "../templates/saved.ts";
import { encodeWorkspace, readWorkspace } from "../workspace/bundle.ts";
import {
  createEndpoint,
  deleteEndpoint,
  listDeliveries,
  listEndpoints,
  pingEndpoint,
  redeliver,
  updateEndpoint,
  WEBHOOK_TOPICS,
} from "../webhooks/endpoints.ts";
import { DryRun, importRecords, importUsers, type ImportReport } from "../import/service.ts";
import { AppError } from "../lib/errors.ts";
import { runAfterResponse } from "../http.ts";
import { processTenantOutbox, runDueJobs, workerDeps } from "../jobs/runner.ts";

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

const saveMeta = z.object({ name: z.string().trim().min(1).max(120), summary: z.string().trim().max(500).optional(), replace: z.boolean().default(false) });
const saveBody = saveMeta.extend({ definition: z.unknown(), source: z.enum(["wizard", "file"]).default("file") });
const installBody = z.object({ definition: z.unknown(), options: z.record(z.string(), z.unknown()).default({}) });

function fileSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "template";
}

/** Run an import; a dry run (the default) reports what would happen, then rolls back. */
async function withDryRun(c: Ctx, fn: (tx: Tx, actor: Actor) => Promise<ImportReport>): Promise<ImportReport> {
  try {
    return await asAdmin(c, async (tx, actor) => {
      const report = await fn(tx, actor);
      if (report.dryRun) throw new DryRun(report);
      return report;
    });
  } catch (err) {
    if (err instanceof DryRun) return err.report;
    throw err;
  }
}

/** Deliver queued webhooks now rather than on the next cron sweep. */
async function deliverSoon(c: Ctx): Promise<void> {
  await runDueJobs(workerDeps(c.get("deps"), c.get("sql"), c), { limit: 10 });
}

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
    if (requireRole(c, "admin").demo && body && typeof body === "object" && (body as { inbound?: unknown }).inbound) {
      throw new AppError("forbidden", "Demo sandboxes cannot receive email");
    }
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

  // ---------------------------------------------------------------- templates
  // Built-ins plus the workspace's saved templates (saved from a project, built in the setup
  // wizard, or uploaded from a file).
  .get("/templates", async (c) => {
    const saved = await asAdmin(c, (tx) => listSaved(tx));
    return c.json({ templates: templateSummaries(), saved });
  })
  .get("/templates/builtin/:key", (c) => {
    const t = getTemplate(c.req.param("key"));
    if (!t) throw notFound("Template");
    return c.json({ key: t.key, definition: t.definition, summary: summarize(t.definition) });
  })
  .get("/templates/saved/:id", async (c) => {
    const t = await asAdmin(c, (tx) => getSaved(tx, c.req.param("id")));
    return c.json({ ...t, summary: summarize(t.definition) });
  })
  .get("/templates/saved/:id/download", async (c) => {
    const t = await asAdmin(c, async (tx, actor) => {
      const saved = await getSaved(tx, c.req.param("id"));
      await audit(tx, actor, { entity: "template", entityId: saved.id, action: "download" });
      return saved;
    });
    return new Response(JSON.stringify(t.definition, null, 2), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${fileSlug(t.name)}.tend247-template.json"`,
        "cache-control": "no-store",
      },
    });
  })
  .delete("/templates/saved/:id", async (c) => {
    await asAdmin(c, (tx, actor) => deleteSaved(tx, actor, c.req.param("id")));
    return c.json({ ok: true });
  })
  /** Save a definition (from the wizard or an uploaded file) as a workspace template. */
  .post("/templates/saved", async (c) => {
    const body = parse(saveBody, await readJson(c));
    const template = await asAdmin(c, async (tx, actor) => {
      // Check it would install (apart from its project key, which is chosen at install time).
      const def = await checkDefinition(tx, actor, body.definition, {}, { anyKey: true });
      return saveTemplate(tx, actor, def, body, body.source);
    });
    return c.json({ template }, 201);
  })
  /** "Save as template": the project's configuration, without records, people or secrets. */
  .post("/projects/:id/save-template", async (c) => {
    const body = await readJson(c);
    const meta = parse(saveMeta, body);
    const result = await asAdmin(c, async (tx, actor) => {
      const { definition, warnings } = await projectToDefinition(tx, c.req.param("id"), meta);
      await checkDefinition(tx, actor, definition, {}, { anyKey: true });
      const template = await saveTemplate(tx, actor, definition, meta, "saved");
      return { template, warnings };
    });
    return c.json(result, 201);
  })
  /** Dry-run an install: the same checks as the real thing, nothing saved. */
  .post("/templates/check", async (c) => {
    const body = parse(installBody, await readJson(c));
    const definition = await asAdmin(c, (tx, actor) => checkDefinition(tx, actor, body.definition, body.options));
    return c.json({ ok: true, summary: summarize(definition) });
  })
  /** Install a definition directly (the wizard's last step, or a file uploaded and installed at once). */
  .post("/templates/install", async (c) => {
    const body = parse(installBody, await readJson(c));
    const installed = await asAdmin(c, (tx, actor) => installDefinition(tx, actor, parseDefinition(body.definition), body.options));
    return c.json(installed, 201);
  })
  .post("/templates/:key/install", async (c) => {
    const body = await readJson(c);
    const installed = await asAdmin(c, (tx, actor) => installTemplate(tx, actor, c.req.param("key"), body));
    return c.json(installed, 201);
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
    c.json({ deliveries: await asAdmin(c, (tx) => listDeliveries(tx, { endpointId: c.req.query("endpointId") })) }),
  )
  .post("/webhook-deliveries/:id/redeliver", async (c) => {
    const id = await asAdmin(c, (tx, actor) => redeliver(tx, actor, c.req.param("id")));
    await runAfterResponse(c, deliverSoon(c));
    return c.json({ id }, 201);
  })

  // ---------------------------------------------------------------- webhook endpoints
  .get("/webhooks", async (c) => c.json({ endpoints: await asAdmin(c, (tx) => listEndpoints(tx)), topics: WEBHOOK_TOPICS }))
  .post("/webhooks", async (c) => {
    const body = await readJson(c);
    const allowHttp = c.get("deps").config.devLogin;
    return c.json({ endpoint: await asAdmin(c, (tx, actor) => createEndpoint(tx, actor, body, { allowHttp })) }, 201);
  })
  .patch("/webhooks/:id", async (c) => {
    const body = await readJson(c);
    const allowHttp = c.get("deps").config.devLogin;
    return c.json({ endpoint: await asAdmin(c, (tx, actor) => updateEndpoint(tx, actor, c.req.param("id"), body, { allowHttp })) });
  })
  .delete("/webhooks/:id", async (c) => {
    await asAdmin(c, (tx, actor) => deleteEndpoint(tx, actor, c.req.param("id")));
    return c.json({ ok: true });
  })
  .post("/webhooks/:id/ping", async (c) => {
    const id = await asAdmin(c, (tx, actor) => pingEndpoint(tx, actor, c.req.param("id")));
    await runAfterResponse(c, deliverSoon(c));
    return c.json({ deliveryId: id }, 201);
  })

  // ---------------------------------------------------------------- CSV import (dry run first)
  .post("/import/users", async (c) => {
    const body = await readJson(c);
    return c.json(await withDryRun(c, (tx, actor) => importUsers(tx, actor, body)));
  })
  .post("/import/records", async (c) => {
    const body = await readJson(c);
    const auth = requireRole(c, "admin");
    if (auth.demo) throw new AppError("forbidden", "Demo sandboxes cannot import records");
    const report = await withDryRun(c, (tx, actor) => importRecords(tx, actor, body));
    if (!report.dryRun) await runAfterResponse(c, processTenantOutbox(workerDeps(c.get("deps"), c.get("sql"), c), auth.tenantId));
    return c.json(report);
  })

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

  /** The whole workspace as a gzipped NDJSON bundle (npm run workspace:import reads it). */
  .get("/workspace/export", async (c) => {
    const auth = requireRole(c, "admin");
    const data = await readWorkspace(c.get("sql"), auth.tenantId, { maxRows: 250_000 });
    await asAdmin(c, (tx, actor) => audit(tx, actor, { entity: "workspace", entityId: actor.tenantId, action: "export" }));
    const body = await encodeWorkspace(data);
    const name = `${data.header.workspace.slug}-${data.header.exportedAt.slice(0, 10)}.tend247.ndjson.gz`;
    return new Response(body as Uint8Array<ArrayBuffer>, {
      headers: {
        "content-type": "application/gzip",
        "content-disposition": `attachment; filename="${name}"`,
        "cache-control": "no-store",
      },
    });
  })

  .get("/audit", async (c) => {
    const q = parse(z.object({ limit: z.coerce.number().int().optional(), before: z.coerce.number().int().optional() }), c.req.query());
    return c.json({ entries: await asAdmin(c, (tx) => listAudit(tx, { limit: q.limit ?? 50, before: q.before })) });
  });
