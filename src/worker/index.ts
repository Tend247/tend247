// Worker entry point. One app per isolate; one database client per request (and per cron
// run or inbound email) over Hyperdrive.
import { createApp } from "./app.ts";
import { loadConfig, type AppConfig } from "./config.ts";
import { createSql, type Sql } from "./db/client.ts";
import { checkDatabase } from "./db/checks.ts";
import type { AppDeps } from "./http.ts";
import {
  CloudflareEmailSender,
  ConsoleEmailSender,
  DisabledEmailSender,
  PostmarkEmailSender,
  ResendEmailSender,
  type EmailSender,
} from "./email/sender.ts";
import { R2BlobStore } from "./attachments/blobs.ts";
import { sweep, workerDeps } from "./jobs/runner.ts";
import { handleInboundEmail } from "./email/inbound.ts";

export interface Env {
  HYPERDRIVE: Hyperdrive;
  ASSETS: Fetcher;
  /** R2 buckets (optional): attachments, their replica, nightly exports. */
  ATTACHMENTS?: R2Bucket;
  ATTACHMENTS_REPLICA?: R2Bucket;
  BACKUPS?: R2Bucket;
  /** Cloudflare Email Service binding (send_email). */
  EMAIL?: unknown;
  [key: string]: unknown;
}

let deps: Omit<AppDeps, "getSql" | "releaseSql"> | null = null;
let app: ReturnType<typeof createApp> | null = null;
let configError: string | null = null;

function emailSender(config: AppConfig, env: Env): EmailSender {
  const e = config.email;
  if (e.provider === "cloudflare" && env.EMAIL) return new CloudflareEmailSender(env.EMAIL, e.from!);
  if (e.provider === "postmark") return new PostmarkEmailSender(e.apiKey!, e.from!);
  if (e.provider === "resend") return new ResendEmailSender(e.apiKey!, e.from!);
  // Development only: the console log contains working sign-in links.
  return config.devLogin ? new ConsoleEmailSender() : new DisabledEmailSender();
}

function getDeps(env: Env) {
  if (deps || configError) return deps;
  try {
    const config = loadConfig(env);
    deps = {
      config,
      email: emailSender(config, env),
      blobs: env.ATTACHMENTS ? new R2BlobStore(env.ATTACHMENTS) : undefined,
      replica: env.ATTACHMENTS_REPLICA ? new R2BlobStore(env.ATTACHMENTS_REPLICA) : undefined,
      backups: env.BACKUPS ? new R2BlobStore(env.BACKUPS) : undefined,
    };
  } catch (err) {
    configError = (err as Error).message;
  }
  return deps;
}

function getApp(env: Env) {
  if (app) return app;
  const d = getDeps(env);
  if (!d) return null;
  app = createApp({
    ...d,
    getSql: () => createSql(env.HYPERDRIVE.connectionString),
    releaseSql: (c, sql: Sql, pending) => c.executionCtx.waitUntil(pending.then(() => sql.end({ timeout: 5 }))),
  });
  return app;
}

/** Background entry points refuse to run on an unsafe database role, like the app does. */
async function withBackgroundSql(env: Env, fn: (sql: Sql, d: NonNullable<typeof deps>) => Promise<void>): Promise<void> {
  const d = getDeps(env);
  if (!d) throw new Error(`Tend 24/7 is misconfigured: ${configError}`);
  const sql = createSql(env.HYPERDRIVE.connectionString);
  try {
    const check = await checkDatabase(sql);
    if (!check.ok) throw new Error(`Tend 24/7 database check failed: ${check.problems.join("; ")}`);
    await fn(sql, d);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const instance = getApp(env);
    if (!instance) {
      return Response.json({ error: { code: "misconfigured", message: configError } }, { status: 503 });
    }
    return instance.fetch(request, env, ctx);
  },

  /** Every minute (wrangler.jsonc triggers.crons): events, timers, nightly jobs. */
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(withBackgroundSql(env, (sql, d) => sweep(workerDeps({ ...d, getSql: () => sql }, sql))));
  },

  /** Cloudflare Email Routing delivers queue mail and replies here. */
  async email(message, env, _ctx): Promise<void> {
    if (message.rawSize > 25 * 1024 * 1024) {
      message.setReject("Message too large");
      return;
    }
    await withBackgroundSql(env, async (sql, d) => {
      const result = await handleInboundEmail(workerDeps({ ...d, getSql: () => sql }, sql), {
        to: message.to,
        from: message.from,
        raw: message.raw,
      });
      if (["unauthenticated", "unknown_address", "unknown_sender", "not_allowed"].includes(result.outcome)) {
        message.setReject(
          result.outcome === "unknown_address"
            ? "No such address"
            : result.outcome === "unauthenticated"
              ? "Sender could not be verified"
              : "Sender is not allowed to write to this address",
        );
      }
    });
  },
} satisfies ExportedHandler<Env>;
