import { Hono } from "hono";
import type { AppEnv, Ctx } from "../http.ts";
import { actorOf, readJson, requireAuth, requireRole, runAfterResponse } from "../http.ts";
import { withTenant, type Tx } from "../db/client.ts";
import type { Actor } from "../audit.ts";
import { getCompiledConfig } from "../config/service.ts";
import { listUsers } from "../users/service.ts";
import { listTeams } from "../teams/service.ts";
import {
  bulkUpdate,
  createRecord,
  deleteRecord,
  getBoard,
  getRecord,
  listEvents,
  listRecords,
  listTrash,
  purgeRecord,
  restoreRecord,
  revertChange,
  updateRecord,
  type ListFilters,
  type Sort,
} from "../records/service.ts";
import { runTransition, transitionRecord } from "../records/transitions.ts";
import { availableTransitions } from "../workflow/definition.ts";
import { getWorkflow } from "../config/versions.ts";
import {
  createComment,
  deleteComment,
  editComment,
  listComments,
  listDeletedComments,
  listWatchers,
  restoreComment,
  setWatching,
} from "../comments/service.ts";
import {
  deleteAttachment,
  downloadAttachment,
  listAttachments,
  listDeletedAttachments,
  restoreAttachment,
  uploadAttachment,
} from "../attachments/service.ts";
import { createLink, createView, deleteLink, deleteView, listLinks, listViews, updateView } from "../views/service.ts";
import { cancelApproval, decideApproval, listMyApprovals, listRecordApprovals } from "../approvals/service.ts";
import { listClocks } from "../sla/service.ts";
import { getSettings } from "../settings/service.ts";
import { listNotifications, markRead, getPrefs, updatePrefs } from "../notifications/service.ts";
import { processTenantOutbox, workerDeps } from "../jobs/runner.ts";
import { AppError } from "../lib/errors.ts";
import { listParam } from "../lib/validate.ts";
import { createToken, listTokens, revokeToken } from "../tokens/service.ts";
import { getDashboard } from "../dashboard/service.ts";
import { bump, DEMO_ATTACHMENT_MAX_MB } from "../demo/service.ts";
import {
  completeSprint,
  createSprint,
  deleteSprint,
  getBacklog,
  listSprints,
  planRecord,
  sprintReport,
  startSprint,
  updateSprint,
  velocity,
} from "../agile/service.ts";

/** Run `fn` in the signed-in person's workspace. */
function inTenant<T>(c: Ctx, fn: (tx: Tx, actor: Actor) => Promise<T>): Promise<T> {
  const auth = requireAuth(c);
  return withTenant(c.get("sql"), auth.tenantId, (tx) => fn(tx, actorOf(auth)));
}

function parseCustomFilter(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new AppError("bad_request", "custom must be a JSON object, e.g. {\"vendor\":\"Acme\"}");
}

export function filtersFromQuery(q: Record<string, string>): ListFilters {
  return {
    projectId: q.projectId || undefined,
    recordTypeId: q.recordTypeId || undefined,
    status: listParam(q.status),
    statusCategory: listParam(q.statusCategory) as ListFilters["statusCategory"],
    priority: listParam(q.priority) as ListFilters["priority"],
    assigneeId: q.assigneeId || undefined,
    teamId: q.teamId || undefined,
    requesterId: q.requesterId || undefined,
    sla: (q.sla as ListFilters["sla"]) || undefined,
    createdAfter: q.createdAfter || undefined,
    createdBefore: q.createdBefore || undefined,
    q: q.q || undefined,
    custom: parseCustomFilter(q.custom),
    sprintId: q.sprintId || undefined,
    epicId: q.epicId || undefined,
    sort: (q.sort as Sort) || undefined,
    limit: q.limit ? Number(q.limit) : undefined,
    cursor: q.cursor || undefined,
  };
}

export const apiRoutes = new Hono<AppEnv>()
  // After a successful change, handle the events it queued (notifications, automation,
  // webhooks) once the response is on its way; the cron sweep is the backstop.
  .use(async (c, next) => {
    await next();
    const auth = c.get("auth");
    if (c.req.method !== "GET" && auth && c.res.status < 400) {
      await runAfterResponse(c, processTenantOutbox(workerDeps(c.get("deps"), c.get("sql"), c), auth.tenantId));
    }
  })

  .get("/me", (c) => {
    const auth = requireAuth(c);
    return c.json({
      id: auth.userId,
      email: auth.email,
      displayName: auth.displayName,
      role: auth.role,
      workspaceId: auth.tenantId,
      readOnly: auth.readOnly,
      demo: auth.demo,
    });
  })

  /** Projects → record types → fields, workflow and layout, for rendering forms and boards. */
  .get("/config", async (c) => {
    const projects = await inTenant(c, (tx, actor) => getCompiledConfig(tx, actor));
    const auth = requireAuth(c);
    const settings = await getSettings(c.get("sql"), auth.tenantId);
    return c.json({ projects, settings: { attachmentMaxMb: settings.attachmentMaxMb, timezone: settings.timezone } });
  })

  /** People for assignee and person-field pickers (staff only). */
  .get("/users", async (c) => {
    requireRole(c, "admin", "agent");
    const users = await inTenant(c, (tx) => listUsers(tx));
    return c.json({ users: users.map(({ id, displayName, email, role }) => ({ id, displayName, email, role })) });
  })

  .get("/teams", async (c) => {
    requireRole(c, "admin", "agent");
    const teams = await inTenant(c, (tx) => listTeams(tx));
    return c.json({ teams });
  })

  // ---------------------------------------------------------------- records

  .get("/records", async (c) => {
    const filters = filtersFromQuery(c.req.query());
    return c.json(await inTenant(c, (tx, actor) => listRecords(tx, actor, filters)));
  })

  .get("/board", async (c) => {
    const filters = { ...filtersFromQuery(c.req.query()), columns: c.req.query("columns") };
    return c.json(await inTenant(c, (tx, actor) => getBoard(tx, actor, filters)));
  })

  .post("/records", async (c) => {
    const body = await readJson(c);
    const auth = requireAuth(c);
    const record = await inTenant(c, (tx, actor) => createRecord(tx, actor, body));
    if (auth.demo) await bump(c.get("sql"), "demo.requests");
    return c.json({ record }, 201);
  })

  .post("/records/bulk", async (c) => {
    const body = await readJson(c);
    const result = await inTenant(c, (tx, actor) =>
      bulkUpdate(tx, actor, body, (sp, a, record, key) => runTransition(sp, a, record, key)),
    );
    return c.json(result);
  })

  /** A record with what the detail page needs: transitions, SLA clocks, approvals, links. */
  .get("/records/:idOrKey", async (c) => {
    const data = await inTenant(c, async (tx, actor) => {
      const record = await getRecord(tx, actor, c.req.param("idOrKey"));
      const wf = await getWorkflow(tx, record.recordTypeId);
      const transitions = record.pendingApprovalId
        ? []
        : availableTransitions(wf.definition, record.status, actor.role).map((t) => ({
            key: t.key,
            name: t.name,
            to: t.to,
            requiredFields: t.requiredFields,
            needsApproval: Boolean(t.approval),
          }));
      return {
        record,
        transitions,
        sla: await listClocks(tx, record.id),
        approvals: await listRecordApprovals(tx, actor, record.id),
        links: await listLinks(tx, actor, record.id),
        watching: Boolean(
          actor.userId &&
            (await tx`select 1 from record_watchers where record_id = ${record.id} and user_id = ${actor.userId}`).length,
        ),
      };
    });
    return c.json(data);
  })

  .patch("/records/:idOrKey", async (c) => {
    const body = await readJson(c);
    const record = await inTenant(c, (tx, actor) => updateRecord(tx, actor, c.req.param("idOrKey"), body));
    return c.json({ record });
  })

  .post("/records/:idOrKey/transitions", async (c) => {
    const body = await readJson(c);
    const result = await inTenant(c, (tx, actor) => transitionRecord(tx, actor, c.req.param("idOrKey"), body));
    return c.json(result);
  })

  .delete("/records/:idOrKey", async (c) => {
    const record = await inTenant(c, (tx, actor) => deleteRecord(tx, actor, c.req.param("idOrKey")));
    return c.json({ record });
  })

  .post("/records/:idOrKey/restore", async (c) => {
    const record = await inTenant(c, (tx, actor) => restoreRecord(tx, actor, c.req.param("idOrKey")));
    return c.json({ record });
  })

  .get("/records/:idOrKey/events", async (c) => {
    const events = await inTenant(c, (tx, actor) => listEvents(tx, actor, c.req.param("idOrKey")));
    return c.json({ events });
  })

  .post("/records/:idOrKey/events/:eventId/revert", async (c) => {
    const body = await readJson(c);
    const record = await inTenant(c, (tx, actor) =>
      revertChange(tx, actor, c.req.param("idOrKey"), c.req.param("eventId"), body),
    );
    return c.json({ record });
  })

  // ---------------------------------------------------------------- comments and watchers

  .get("/records/:idOrKey/comments", async (c) => {
    const comments = await inTenant(c, (tx, actor) => listComments(tx, actor, c.req.param("idOrKey")));
    return c.json({ comments });
  })
  .post("/records/:idOrKey/comments", async (c) => {
    const body = await readJson(c);
    const comment = await inTenant(c, (tx, actor) => createComment(tx, actor, c.req.param("idOrKey"), body));
    return c.json({ comment }, 201);
  })
  .patch("/comments/:id", async (c) => {
    const body = await readJson(c);
    const comment = await inTenant(c, (tx, actor) => editComment(tx, actor, c.req.param("id"), body));
    return c.json({ comment });
  })
  .delete("/comments/:id", async (c) => {
    await inTenant(c, (tx, actor) => deleteComment(tx, actor, c.req.param("id")));
    return c.json({ ok: true });
  })
  .post("/comments/:id/restore", async (c) => {
    const comment = await inTenant(c, (tx, actor) => restoreComment(tx, actor, c.req.param("id")));
    return c.json({ comment });
  })

  .get("/records/:idOrKey/watchers", async (c) => {
    const watchers = await inTenant(c, (tx, actor) => listWatchers(tx, actor, c.req.param("idOrKey")));
    return c.json({ watchers });
  })
  .post("/records/:idOrKey/watchers", async (c) => {
    const body = await readJson(c);
    await inTenant(c, (tx, actor) => setWatching(tx, actor, c.req.param("idOrKey"), body));
    return c.json({ ok: true });
  })

  // ---------------------------------------------------------------- attachments

  .get("/records/:idOrKey/attachments", async (c) => {
    const attachments = await inTenant(c, (tx, actor) => listAttachments(tx, actor, c.req.param("idOrKey")));
    return c.json({ attachments });
  })
  /**
   * Upload one file as the raw request body. Needs the X-Tend-Upload: 1 header (a custom
   * header cannot be sent cross-site without a CORS preflight); the file name goes in
   * X-Filename, URI-encoded.
   */
  .post("/records/:idOrKey/attachments", async (c) => {
    const auth = requireAuth(c);
    const { blobs, replica } = c.get("deps");
    if (!blobs) throw new AppError("bad_request", "File storage is not configured");
    const settings = await getSettings(c.get("sql"), auth.tenantId);
    const maxMb = auth.demo ? Math.min(DEMO_ATTACHMENT_MAX_MB, settings.attachmentMaxMb) : settings.attachmentMaxMb;
    // The size must be declared up front so an oversized body is refused before it is read.
    const declared = Number(c.req.header("content-length") ?? "NaN");
    if (!Number.isFinite(declared)) throw new AppError("bad_request", "Send the file with a Content-Length header");
    if (declared > maxMb * 1024 * 1024) {
      throw new AppError("bad_request", `Files can be at most ${maxMb} MB${auth.demo ? " in the demo" : ""}`);
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const attachment = await uploadAttachment(
      c.get("sql"),
      actorOf(auth),
      blobs,
      c.req.param("idOrKey"),
      {
        filename: c.req.header("x-filename"),
        contentType: c.req.header("content-type"),
        bytes,
        commentId: c.req.query("commentId") || null,
      },
      { replicate: Boolean(replica) },
    );
    return c.json({ attachment }, 201);
  })
  .get("/attachments/:id", async (c) => {
    const { blobs } = c.get("deps");
    if (!blobs) throw new AppError("bad_request", "File storage is not configured");
    return inTenant(c, (tx, actor) => downloadAttachment(tx, actor, blobs, c.req.param("id"), c.req.query("inline") === "1"));
  })
  .delete("/attachments/:id", async (c) => {
    await inTenant(c, (tx, actor) => deleteAttachment(tx, actor, c.req.param("id")));
    return c.json({ ok: true });
  })
  .post("/attachments/:id/restore", async (c) => {
    const attachment = await inTenant(c, (tx, actor) => restoreAttachment(tx, actor, c.req.param("id")));
    return c.json({ attachment });
  })

  // ---------------------------------------------------------------- links

  .post("/records/:idOrKey/links", async (c) => {
    const body = await readJson(c);
    const link = await inTenant(c, (tx, actor) => createLink(tx, actor, c.req.param("idOrKey"), body));
    return c.json({ link }, 201);
  })
  .delete("/links/:id", async (c) => {
    await inTenant(c, (tx, actor) => deleteLink(tx, actor, c.req.param("id")));
    return c.json({ ok: true });
  })

  // ---------------------------------------------------------------- approvals

  .get("/approvals", async (c) => {
    const approvals = await inTenant(c, (tx, actor) => listMyApprovals(tx, actor));
    return c.json({ approvals });
  })
  .post("/approvals/:id/decision", async (c) => {
    const body = await readJson(c);
    const approval = await inTenant(c, (tx, actor) => decideApproval(tx, actor, c.req.param("id"), body));
    return c.json({ approval });
  })
  .post("/approvals/:id/cancel", async (c) => {
    const approval = await inTenant(c, (tx, actor) => cancelApproval(tx, actor, c.req.param("id")));
    return c.json({ approval });
  })

  // ---------------------------------------------------------------- saved views

  .get("/views", async (c) => c.json({ views: await inTenant(c, (tx, actor) => listViews(tx, actor)) }))
  .post("/views", async (c) => {
    const body = await readJson(c);
    return c.json({ view: await inTenant(c, (tx, actor) => createView(tx, actor, body)) }, 201);
  })
  .patch("/views/:id", async (c) => {
    const body = await readJson(c);
    return c.json({ view: await inTenant(c, (tx, actor) => updateView(tx, actor, c.req.param("id"), body)) });
  })
  .delete("/views/:id", async (c) => {
    await inTenant(c, (tx, actor) => deleteView(tx, actor, c.req.param("id")));
    return c.json({ ok: true });
  })

  // ---------------------------------------------------------------- notifications

  .get("/notifications", async (c) => {
    const unreadOnly = c.req.query("unread") === "1";
    return c.json(await inTenant(c, (tx, actor) => listNotifications(tx, actor, { unreadOnly })));
  })
  .post("/notifications/read", async (c) => {
    const body = await readJson(c);
    await inTenant(c, (tx, actor) => markRead(tx, actor, body));
    return c.json({ ok: true });
  })
  .get("/notification-prefs", async (c) => c.json({ prefs: await inTenant(c, (tx, actor) => getPrefs(tx, actor)) }))
  .patch("/notification-prefs", async (c) => {
    const body = await readJson(c);
    return c.json({ prefs: await inTenant(c, (tx, actor) => updatePrefs(tx, actor, body)) });
  })

  // ---------------------------------------------------------------- dashboard

  .get("/dashboard", async (c) => {
    const auth = requireAuth(c);
    const settings = await getSettings(c.get("sql"), auth.tenantId);
    const days = Number(c.req.query("days") ?? 30);
    return c.json(
      await inTenant(c, (tx, actor) =>
        getDashboard(tx, actor, { projectId: c.req.query("projectId"), days: Number.isFinite(days) ? days : 30, timezone: settings.timezone }),
      ),
    );
  })

  // ---------------------------------------------------------------- API tokens (signed-in people only)

  .get("/tokens", async (c) => {
    const all = c.req.query("all") === "1";
    return c.json({ tokens: await inTenant(c, (tx, actor) => listTokens(tx, actor, { all })) });
  })
  .post("/tokens", async (c) => {
    const body = await readJson(c);
    const auth = requireAuth(c);
    const created = await inTenant(c, (tx, actor) => createToken(tx, actor, body, { demo: auth.demo, readOnly: auth.readOnly || auth.kind !== "session" }));
    return c.json(created, 201);
  })
  .delete("/tokens/:id", async (c) => {
    await inTenant(c, (tx, actor) => revokeToken(tx, actor, c.req.param("id")));
    return c.json({ ok: true });
  })

  // ---------------------------------------------------------------- agile (staff, agile projects)

  .get("/projects/:id/backlog", async (c) => c.json(await inTenant(c, (tx, actor) => getBacklog(tx, actor, c.req.param("id")))))
  .get("/projects/:id/sprints", async (c) => c.json({ sprints: await inTenant(c, (tx, actor) => listSprints(tx, actor, c.req.param("id"))) }))
  .post("/projects/:id/sprints", async (c) => {
    const body = await readJson(c);
    return c.json({ sprint: await inTenant(c, (tx, actor) => createSprint(tx, actor, c.req.param("id"), body)) }, 201);
  })
  .get("/projects/:id/velocity", async (c) => c.json(await inTenant(c, (tx, actor) => velocity(tx, actor, c.req.param("id")))))
  .patch("/sprints/:id", async (c) => {
    const body = await readJson(c);
    return c.json({ sprint: await inTenant(c, (tx, actor) => updateSprint(tx, actor, c.req.param("id"), body)) });
  })
  .delete("/sprints/:id", async (c) => {
    await inTenant(c, (tx, actor) => deleteSprint(tx, actor, c.req.param("id")));
    return c.json({ ok: true });
  })
  .post("/sprints/:id/start", async (c) => {
    const body = await readJson(c);
    return c.json({ sprint: await inTenant(c, (tx, actor) => startSprint(tx, actor, c.req.param("id"), body)) });
  })
  .post("/sprints/:id/complete", async (c) => {
    const body = await readJson(c);
    return c.json(await inTenant(c, (tx, actor) => completeSprint(tx, actor, c.req.param("id"), body)));
  })
  .get("/sprints/:id/report", async (c) => c.json(await inTenant(c, (tx, actor) => sprintReport(tx, actor, c.req.param("id")))))
  /** Move a record into or out of a sprint and/or to a new place in the backlog order. */
  .post("/records/:idOrKey/plan", async (c) => {
    const body = await readJson(c);
    return c.json({ record: await inTenant(c, (tx, actor) => planRecord(tx, actor, c.req.param("idOrKey"), body)) });
  })

  // ---------------------------------------------------------------- trash (admins)

  .get("/trash", async (c) => {
    const data = await inTenant(c, async (tx, actor) => ({
      records: await listTrash(tx, actor),
      comments: await listDeletedComments(tx, actor),
      attachments: await listDeletedAttachments(tx, actor),
    }));
    return c.json(data);
  })
  .delete("/trash/records/:id", async (c) => {
    const auth = requireRole(c, "admin");
    const settings = await getSettings(c.get("sql"), auth.tenantId);
    await inTenant(c, (tx, actor) =>
      purgeRecord(tx, actor, c.req.param("id"), { replicaRetentionDays: settings.trashRetentionDays }),
    );
    return c.json({ ok: true });
  })
;
