// Worker entry point. One app per isolate; one database client per request over Hyperdrive.
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createSql, type Sql } from "./db/client.ts";
import { ConsoleEmailSender, DisabledEmailSender } from "./email/sender.ts";

export interface Env {
  HYPERDRIVE: Hyperdrive;
  ASSETS: Fetcher;
  [key: string]: unknown;
}

let app: ReturnType<typeof createApp> | null = null;
let configError: string | null = null;

function getApp(env: Env) {
  if (app || configError) return app;
  try {
    const config = loadConfig(env);
    app = createApp({
      config,
      getSql: () => createSql(env.HYPERDRIVE.connectionString),
      releaseSql: (c, sql: Sql, pending) => c.executionCtx.waitUntil(pending.then(() => sql.end({ timeout: 5 }))),
      // Real senders (Cloudflare Email Sending, Postmark, Resend) arrive in Phase 2. Until then
      // email sign-in works only in local development, where links are printed to the console.
      email: config.devLogin ? new ConsoleEmailSender() : new DisabledEmailSender(),
    });
  } catch (err) {
    configError = (err as Error).message;
  }
  return app;
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const instance = getApp(env);
    if (!instance) {
      return Response.json({ error: { code: "misconfigured", message: configError } }, { status: 503 });
    }
    return instance.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
