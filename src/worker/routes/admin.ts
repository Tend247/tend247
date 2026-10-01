import { Hono } from "hono";
import type { AppEnv } from "../http.ts";
import { actorOf, readJson, requireRole } from "../http.ts";
import { withTenant } from "../db/client.ts";
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
import { createUser, listUsers, updateUser } from "../users/service.ts";

/** Workspace configuration. Every route requires the admin role. */
export const adminRoutes = new Hono<AppEnv>()
  .use(async (c, next) => {
    requireRole(c, "admin");
    await next();
  })

  .get("/users", async (c) => {
    const auth = requireRole(c, "admin");
    const users = await withTenant(c.get("sql"), auth.tenantId, (tx) => listUsers(tx, { includeInactive: true }));
    return c.json({ users });
  })
  .post("/users", async (c) => {
    const auth = requireRole(c, "admin");
    const body = await readJson(c);
    const user = await withTenant(c.get("sql"), auth.tenantId, (tx) => createUser(tx, actorOf(auth), body));
    return c.json({ user }, 201);
  })
  .patch("/users/:id", async (c) => {
    const auth = requireRole(c, "admin");
    const body = await readJson(c);
    const user = await withTenant(c.get("sql"), auth.tenantId, (tx) =>
      updateUser(tx, actorOf(auth), c.req.param("id"), body),
    );
    return c.json({ user });
  })

  .get("/projects", async (c) => {
    const auth = requireRole(c, "admin");
    const projects = await withTenant(c.get("sql"), auth.tenantId, (tx) => listProjects(tx, { includeArchived: true }));
    return c.json({ projects });
  })
  .post("/projects", async (c) => {
    const auth = requireRole(c, "admin");
    const body = await readJson(c);
    const project = await withTenant(c.get("sql"), auth.tenantId, (tx) => createProject(tx, actorOf(auth), body));
    return c.json({ project }, 201);
  })
  .patch("/projects/:id", async (c) => {
    const auth = requireRole(c, "admin");
    const body = await readJson(c);
    const project = await withTenant(c.get("sql"), auth.tenantId, (tx) =>
      updateProject(tx, actorOf(auth), c.req.param("id"), body),
    );
    return c.json({ project });
  })

  .post("/projects/:id/record-types", async (c) => {
    const auth = requireRole(c, "admin");
    const body = await readJson(c);
    const recordType = await withTenant(c.get("sql"), auth.tenantId, (tx) =>
      createRecordType(tx, actorOf(auth), c.req.param("id"), body),
    );
    return c.json({ recordType }, 201);
  })
  .patch("/record-types/:id", async (c) => {
    const auth = requireRole(c, "admin");
    const body = await readJson(c);
    const recordType = await withTenant(c.get("sql"), auth.tenantId, (tx) =>
      updateRecordType(tx, actorOf(auth), c.req.param("id"), body),
    );
    return c.json({ recordType });
  })

  .get("/record-types/:id/fields", async (c) => {
    const auth = requireRole(c, "admin");
    const fields = await withTenant(c.get("sql"), auth.tenantId, (tx) =>
      listFields(tx, c.req.param("id"), { includeArchived: c.req.query("includeArchived") === "true" }),
    );
    return c.json({ fields });
  })
  .post("/record-types/:id/fields", async (c) => {
    const auth = requireRole(c, "admin");
    const body = await readJson(c);
    const field = await withTenant(c.get("sql"), auth.tenantId, (tx) =>
      createField(tx, actorOf(auth), c.req.param("id"), body),
    );
    return c.json({ field }, 201);
  })
  .patch("/fields/:id", async (c) => {
    const auth = requireRole(c, "admin");
    const body = await readJson(c);
    const field = await withTenant(c.get("sql"), auth.tenantId, (tx) =>
      updateField(tx, actorOf(auth), c.req.param("id"), body),
    );
    return c.json({ field });
  })

  .get("/audit", async (c) => {
    const auth = requireRole(c, "admin");
    const before = c.req.query("before");
    const entries = await withTenant(c.get("sql"), auth.tenantId, (tx) =>
      listAudit(tx, { limit: Number(c.req.query("limit") ?? 50), before: before ? Number(before) : undefined }),
    );
    return c.json({ entries });
  });
