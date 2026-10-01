import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { AppDeps, AppEnv } from "./http.ts";
import { checkDatabase, type DatabaseCheck } from "./db/checks.ts";
import { resolveSession } from "./auth/sessions.ts";
import { sessionCookieName } from "./http.ts";
import { authRoutes } from "./routes/auth.ts";
import { apiRoutes } from "./routes/api.ts";
import { adminRoutes } from "./routes/admin.ts";
import { AppError, fromPostgres } from "./lib/errors.ts";

const UPLOAD_PATH = /^\/api\/records\/[^/]+\/attachments$/;

/**
 * Build the HTTP app. The Worker entry and the tests both call this, injecting the
 * database client, email sender and configuration.
 */
export function createApp(deps: AppDeps) {
  let dbCheck: Promise<DatabaseCheck> | null = null;
  const app = new Hono<AppEnv>();

  app.onError((err, c) => {
    const appErr = err instanceof AppError ? err : fromPostgres(err);
    if (appErr) {
      return c.json({ error: { code: appErr.code, message: appErr.message, details: appErr.details } }, appErr.status as 400);
    }
    console.error("unhandled error", err);
    return c.json({ error: { code: "internal", message: "Something went wrong" } }, 500);
  });

  app.notFound((c) => c.json({ error: { code: "not_found", message: "Not found" } }, 404));

  // Per-request database client.
  app.use(async (c, next) => {
    const sql = deps.getSql(c);
    c.set("sql", sql);
    c.set("deps", deps);
    c.set("auth", null);
    c.set("background", []);
    try {
      await next();
    } finally {
      deps.releaseSql?.(c, sql, Promise.allSettled(c.get("background")));
    }
  });

  // Fail closed if the database role could bypass row-level security.
  app.use(async (c, next) => {
    dbCheck ??= checkDatabase(c.get("sql")).catch((err) => {
      dbCheck = null;
      return { ok: false, problems: [`database unreachable: ${(err as Error).message}`] };
    });
    const result = await dbCheck;
    if (!result.ok) {
      if (result.problems.some((p) => p.startsWith("database unreachable"))) dbCheck = null;
      // Details go to the server log only; visitors see a generic message.
      console.error("Tend 24/7 database check failed:", result.problems.join("; "));
      throw new AppError("unsafe_database", "Tend 24/7 is not configured correctly. An administrator can find details in the server logs.");
    }
    await next();
  });

  // Cross-site request forgery: unsafe methods must send exactly application/json (a browser
  // cannot send that cross-site without a CORS preflight), and requests the browser marks as
  // cross-site are refused outright.
  app.use(async (c, next) => {
    const m = c.req.method;
    if (m === "POST" || m === "PATCH" || m === "PUT" || m === "DELETE") {
      if (c.req.header("sec-fetch-site") === "cross-site") {
        throw new AppError("forbidden", "Cross-site requests are not allowed");
      }
      const mediaType = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      // File uploads send the raw file; the custom X-Tend-Upload header plays the same role
      // (it cannot be sent cross-site without a preflight).
      const upload = m === "POST" && c.req.header("x-tend-upload") === "1" && UPLOAD_PATH.test(new URL(c.req.url).pathname);
      if (m !== "DELETE" && !upload && mediaType !== "application/json") {
        throw new AppError("unsupported_media_type", "Send JSON with Content-Type: application/json");
      }
    }
    await next();
  });

  app.use(async (c, next) => {
    c.set("auth", await resolveSession(c.get("sql"), getCookie(c, sessionCookieName(c))));
    await next();
  });

  app.get("/healthz", (c) => c.json({ ok: true }));
  app.route("/auth", authRoutes);
  app.route("/api/admin", adminRoutes);
  app.route("/api", apiRoutes);
  // Malformed ids in paths surface as Postgres 22P02 and map to 400 in onError.

  return app;
}
