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
import { resolveToken } from "./tokens/service.ts";
import { enforceAccess } from "./auth/access.ts";
import { deviceRoutes, pairRoutes } from "./routes/devices.ts";
import { demoRoutes } from "./routes/demo.ts";

/** Public routes that still answer when the database check fails (the landing page needs them). */
const PUBLIC_WITHOUT_DB = new Set(["/healthz", "/auth/config", "/auth/demo/stats"]);

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
    c.set("dbReady", true);
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
      if (c.req.method === "GET" && PUBLIC_WITHOUT_DB.has(c.req.path)) {
        c.set("dbReady", false);
        return next();
      }
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
      const upload = m === "POST" && c.req.header("x-tend-upload") === "1" && UPLOAD_PATH.test(c.req.path);
      if (m !== "DELETE" && !upload && mediaType !== "application/json") {
        throw new AppError("unsupported_media_type", "Send JSON with Content-Type: application/json");
      }
    }
    await next();
  });

  // Who is calling: an API token (Authorization: Bearer ...) or a browser session cookie. A
  // request carrying a token never falls back to the cookie.
  app.use(async (c, next) => {
    if (!c.get("dbReady")) return next();
    const authorization = c.req.header("authorization");
    if (authorization !== undefined) {
      const auth = await resolveToken(c.get("sql"), authorization);
      if (!auth) throw new AppError("unauthenticated", "The API token is missing, malformed, revoked or expired");
      const limiter = c.get("deps").rateLimits?.api;
      if (limiter && !(await limiter.limit(`token:${auth.tokenId}`))) {
        throw new AppError("rate_limited", "Too many requests for this token; slow down and retry");
      }
      c.set("auth", auth);
    } else {
      c.set("auth", await resolveSession(c.get("sql"), getCookie(c, sessionCookieName(c))));
    }
    const auth = c.get("auth");
    // c.req.path is the decoded path the router matches on (so /%61pi/... cannot dodge the check).
    enforceAccess(auth, c.req.method, c.req.path);
    // Demo sandboxes: a ceiling on writes per sandbox, so one visitor cannot flood the database.
    // Keyed by visitor, not sandbox: Reset hands out a new sandbox, not a new budget.
    const demoLimiter = c.get("deps").rateLimits?.demoWrite;
    const visitor = c.req.header("cf-connecting-ip") ?? auth?.tenantId;
    if (auth?.demo && demoLimiter && c.req.method !== "GET" && !(await demoLimiter.limit(`demo:${visitor}`))) {
      throw new AppError("rate_limited", "This demo sandbox is making changes very quickly; wait a few seconds");
    }
    await next();
  });

  // API answers are personal: never cache them, never sniff them, never frame them.
  app.use(async (c, next) => {
    await next();
    c.res.headers.set("x-content-type-options", "nosniff");
    c.res.headers.set("referrer-policy", "strict-origin-when-cross-origin");
    c.res.headers.set("x-frame-options", "DENY");
    if (!c.res.headers.has("cache-control")) c.res.headers.set("cache-control", "no-store");
  });

  app.get("/healthz", (c) =>
    c.get("dbReady")
      ? c.json({ ok: true })
      : c.json({ ok: false, error: { code: "unsafe_database", message: "Tend 24/7 is not configured correctly. An administrator can find details in the server logs." } }, 503),
  );
  app.route("/auth", authRoutes);
  app.route("/auth/demo", demoRoutes.auth);
  app.route("/api/demo", demoRoutes.api);
  app.route("/api/devices", deviceRoutes);
  app.route("/auth/pair", pairRoutes);
  app.route("/api/admin", adminRoutes);
  app.route("/api", apiRoutes);
  // Malformed ids in paths surface as Postgres 22P02 and map to 400 in onError.

  return app;
}
