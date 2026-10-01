// Outbound webhooks (the automation "call a webhook" action). Each delivery is signed with the
// workspace's secret: X-Tend-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">.
// Failed deliveries retry with backoff, six attempts in all.
import type { Tx } from "../db/client.ts";
import { withTenant } from "../db/client.ts";
import { randomToken } from "../lib/crypto.ts";
import { scheduleJob } from "./schedule.ts";
import type { WorkerDeps } from "./runner.ts";

const BACKOFF_MINUTES = [1, 5, 30, 120, 720];
export const MAX_ATTEMPTS = 6;

export async function webhookSecret(tx: Tx, tenantId: string, rotate = false): Promise<string> {
  if (rotate) {
    const secret = `whsec_${randomToken(24)}`;
    await tx`
      insert into workspace_secrets (tenant_id, webhook_secret) values (${tenantId}, ${secret})
      on conflict (tenant_id) do update set webhook_secret = excluded.webhook_secret`;
    return secret;
  }
  const [row] = await tx<{ webhookSecret: string }[]>`select webhook_secret from workspace_secrets where tenant_id = ${tenantId}`;
  return row?.webhookSecret ?? webhookSecret(tx, tenantId, true);
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function signWebhook(secret: string, body: string, timestamp: number): Promise<string> {
  return `t=${timestamp},v1=${await hmacHex(secret, `${timestamp}.${body}`)}`;
}

export async function deliverWebhook(w: WorkerDeps, tenantId: string, deliveryId: string): Promise<void> {
  const prepared = await withTenant(w.sql, tenantId, async (tx) => {
    const [d] = await tx<{ id: string; url: string; payload: Record<string, unknown>; status: string; attempts: number }[]>`
      select id, url, payload, status, attempts from webhook_deliveries where id = ${deliveryId}`;
    if (!d || d.status !== "pending") return null;
    return { d, secret: await webhookSecret(tx, tenantId) };
  });
  if (!prepared) return;
  const { d, secret } = prepared;
  const body = JSON.stringify({ deliveryId: d.id, ...d.payload });
  const ts = Math.floor(w.now().getTime() / 1000);
  let status: number | null = null;
  let error: string | null = null;
  try {
    const res = await w.fetch(d.url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "content-type": "application/json",
        "user-agent": "Tend247-Webhooks/1",
        "x-tend-event": String(d.payload.event ?? ""),
        "x-tend-delivery": d.id,
        "x-tend-signature": await signWebhook(secret, body, ts),
      },
      body,
    });
    status = res.status;
    if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
  } catch (err) {
    error = (err as Error).message.slice(0, 300);
  }
  const attempts = d.attempts + 1;
  const final = error === null ? "delivered" : attempts >= MAX_ATTEMPTS ? "failed" : "pending";
  await withTenant(w.sql, tenantId, async (tx) => {
    await tx`
      update webhook_deliveries set attempts = ${attempts}, last_status = ${status}, last_error = ${error}, status = ${final},
        delivered_at = ${final === "delivered" ? new Date() : null}
      where id = ${d.id}`;
    if (final === "pending") {
      const delay = BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)]! * 60_000;
      await scheduleJob(tx, tenantId, "webhook", d.id, new Date(w.now().getTime() + delay));
    }
  });
}
