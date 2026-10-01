import type { Context } from "hono";
import type { AuthContext } from "./auth/sessions.ts";
import type { Sql } from "./db/client.ts";
import type { AppConfig } from "./config.ts";
import type { EmailSender } from "./email/sender.ts";
import type { BlobStore } from "./attachments/blobs.ts";
import type { FetchLike } from "./auth/oidc.ts";
import type { Actor } from "./audit.ts";
import { AppError, forbidden } from "./lib/errors.ts";

export interface AppDeps {
  config: AppConfig;
  /** Database client for this request (the Worker creates one per request over Hyperdrive). */
  getSql: (c: Context) => Sql;
  /**
   * Called after the response is produced, e.g. to close a per-request client. `pending`
   * settles when work scheduled with runAfterResponse() is done; close the client after it.
   */
  releaseSql?: (c: Context, sql: Sql, pending: Promise<unknown>) => void;
  email: EmailSender;
  /** Fetch used for OIDC discovery and token calls (tests inject a fake provider). */
  oidcFetch?: FetchLike;
  /** Attachment storage (R2 bucket ATTACHMENTS). Without it, uploads are turned off. */
  blobs?: BlobStore;
  /** Attachment replica (R2 bucket ATTACHMENTS_REPLICA), copied after each upload. */
  replica?: BlobStore;
  /** Nightly export destination (R2 bucket BACKUPS, ideally in another account). */
  backups?: BlobStore;
  /** Fetch used for outbound webhooks (tests inject a fake). */
  webhookFetch?: (input: string, init: RequestInit) => Promise<Response>;
  /** Clock override for tests. */
  now?: () => Date;
}

export type AppEnv = {
  Variables: {
    sql: Sql;
    auth: AuthContext | null;
    deps: AppDeps;
    background: Promise<unknown>[];
  };
};

export type Ctx = Context<AppEnv>;

export function requireAuth(c: Ctx): AuthContext {
  const auth = c.get("auth");
  if (!auth) throw new AppError("unauthenticated", "Sign in to continue");
  return auth;
}

export function actorOf(auth: AuthContext): Actor {
  return { tenantId: auth.tenantId, userId: auth.userId, role: auth.role };
}

export function requireRole(c: Ctx, ...roles: AuthContext["role"][]): AuthContext {
  const auth = requireAuth(c);
  if (!roles.includes(auth.role)) throw forbidden();
  return auth;
}

export async function readJson(c: Ctx): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new AppError("bad_request", "Request body must be valid JSON");
  }
}

export function originOf(c: Ctx, config: AppConfig): string {
  return config.publicUrl ?? new URL(c.req.url).origin;
}

export function isSecure(c: Context): boolean {
  return new URL(c.req.url).protocol === "https:";
}

/**
 * Over HTTPS the session cookie uses the __Host- prefix, so a sibling subdomain cannot set or
 * shadow it. Plain HTTP (local development, tests) cannot use the prefix.
 */
export function sessionCookieName(c: Context): string {
  return isSecure(c) ? "__Host-t247_session" : "t247_session";
}

/**
 * Run work after the response when the platform allows it (Workers), otherwise inline (tests).
 * The request's database client stays open until the work settles.
 */
export async function runAfterResponse(c: Ctx, work: Promise<unknown>): Promise<void> {
  const guarded = work.catch((err) => console.error("background task failed:", (err as Error).message));
  let ctx: { waitUntil(promise: Promise<unknown>): void } | null = null;
  try {
    ctx = c.executionCtx;
  } catch {
    ctx = null;
  }
  if (!ctx) {
    await guarded;
    return;
  }
  c.get("background").push(guarded);
  ctx.waitUntil(guarded);
}
