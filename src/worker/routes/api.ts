import { Hono } from "hono";
import type { AppEnv } from "../http.ts";
import { actorOf, readJson, requireAuth, requireRole } from "../http.ts";
import { withTenant } from "../db/client.ts";
import { getCompiledConfig } from "../config/service.ts";
import { listUsers } from "../users/service.ts";
import {
  createRecord,
  deleteRecord,
  getRecord,
  listEvents,
  listRecords,
  listTrash,
  restoreRecord,
  updateRecord,
  type ListFilters,
} from "../records/service.ts";
import { AppError } from "../lib/errors.ts";

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

export const apiRoutes = new Hono<AppEnv>()
  .get("/me", (c) => {
    const auth = requireAuth(c);
    return c.json({
      id: auth.userId,
      email: auth.email,
      displayName: auth.displayName,
      role: auth.role,
      workspaceId: auth.tenantId,
    });
  })

  /** Projects → record types → active fields, for rendering forms and filters. */
  .get("/config", async (c) => {
    const auth = requireAuth(c);
    const projects = await withTenant(c.get("sql"), auth.tenantId, (tx) => getCompiledConfig(tx));
    return c.json({ projects });
  })

  /** People for assignee and person-field pickers (staff only). */
  .get("/users", async (c) => {
    const auth = requireRole(c, "admin", "agent");
    const users = await withTenant(c.get("sql"), auth.tenantId, (tx) => listUsers(tx));
    return c.json({ users: users.map(({ id, displayName, email, role }) => ({ id, displayName, email, role })) });
  })

  .get("/records", async (c) => {
    const auth = requireAuth(c);
    const q = c.req.query();
    const filters: ListFilters = {
      projectId: q.projectId || undefined,
      recordTypeId: q.recordTypeId || undefined,
      statusCategory: (q.statusCategory as ListFilters["statusCategory"]) || undefined,
      assigneeId: q.assigneeId || undefined,
      q: q.q || undefined,
      custom: parseCustomFilter(q.custom),
      limit: q.limit ? Number(q.limit) : undefined,
      cursor: q.cursor || undefined,
    };
    if (filters.statusCategory && !["todo", "in_progress", "done"].includes(filters.statusCategory)) {
      throw new AppError("bad_request", "statusCategory must be todo, in_progress or done");
    }
    const page = await withTenant(c.get("sql"), auth.tenantId, (tx) => listRecords(tx, actorOf(auth), filters));
    return c.json(page);
  })

  .post("/records", async (c) => {
    const auth = requireAuth(c);
    const body = await readJson(c);
    const record = await withTenant(c.get("sql"), auth.tenantId, (tx) => createRecord(tx, actorOf(auth), body));
    return c.json({ record }, 201);
  })

  .get("/records/:idOrKey", async (c) => {
    const auth = requireAuth(c);
    const record = await withTenant(c.get("sql"), auth.tenantId, (tx) =>
      getRecord(tx, actorOf(auth), c.req.param("idOrKey")),
    );
    return c.json({ record });
  })

  .patch("/records/:idOrKey", async (c) => {
    const auth = requireAuth(c);
    const body = await readJson(c);
    const record = await withTenant(c.get("sql"), auth.tenantId, (tx) =>
      updateRecord(tx, actorOf(auth), c.req.param("idOrKey"), body),
    );
    return c.json({ record });
  })

  .delete("/records/:idOrKey", async (c) => {
    const auth = requireAuth(c);
    const record = await withTenant(c.get("sql"), auth.tenantId, (tx) =>
      deleteRecord(tx, actorOf(auth), c.req.param("idOrKey")),
    );
    return c.json({ record });
  })

  .post("/records/:idOrKey/restore", async (c) => {
    const auth = requireAuth(c);
    const record = await withTenant(c.get("sql"), auth.tenantId, (tx) =>
      restoreRecord(tx, actorOf(auth), c.req.param("idOrKey")),
    );
    return c.json({ record });
  })

  .get("/records/:idOrKey/events", async (c) => {
    const auth = requireAuth(c);
    const events = await withTenant(c.get("sql"), auth.tenantId, (tx) =>
      listEvents(tx, actorOf(auth), c.req.param("idOrKey")),
    );
    return c.json({ events });
  })

  .get("/trash", async (c) => {
    const auth = requireAuth(c);
    const records = await withTenant(c.get("sql"), auth.tenantId, (tx) => listTrash(tx, actorOf(auth)));
    return c.json({ records });
  });
