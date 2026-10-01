import { afterAll } from "vitest";
import { createApp } from "../src/worker/app.ts";
import { createSql, withTenant, type Sql } from "../src/worker/db/client.ts";
import type { AppConfig } from "../src/worker/config.ts";
import { MemoryEmailSender } from "../src/worker/email/sender.ts";
import type { FetchLike } from "../src/worker/auth/oidc.ts";
import { insertUser } from "../src/worker/users/service.ts";
import type { Role } from "../src/worker/auth/sessions.ts";
import { APP_URL, OWNER_URL } from "./setup/env.ts";

const clients: Sql[] = [];

export function appSql(): Sql {
  const sql = createSql(APP_URL, { max: 4 });
  clients.push(sql);
  return sql;
}

export function ownerSql(): Sql {
  const sql = createSql(OWNER_URL, { max: 2 });
  clients.push(sql);
  return sql;
}

afterAll(async () => {
  await Promise.all(clients.splice(0).map((c) => c.end({ timeout: 2 })));
});

export const baseConfig: AppConfig = {
  sessionSecret: "test-secret-test-secret-test-secret-123",
  sessionTtlHours: 24,
  devLogin: true,
  oidc: null,
  requesterDomains: ["fernhollow.test"],
  publicUrl: null,
  publicSite: false,
  repoUrl: null,
};

export function makeApp(
  sql: Sql,
  opts: { config?: Partial<AppConfig>; email?: MemoryEmailSender; oidcFetch?: FetchLike } = {},
) {
  const email = opts.email ?? new MemoryEmailSender();
  const app = createApp({
    config: { ...baseConfig, ...opts.config },
    getSql: () => sql,
    email,
    oidcFetch: opts.oidcFetch,
  });
  return { app, email };
}

let seq = 0;
export function unique(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

export interface TestWorkspace {
  id: string;
  slug: string;
  admin: { id: string; email: string };
}

/** Create a workspace with one admin user. */
export async function createWorkspace(sql: Sql, name = "Fernhollow Foods"): Promise<TestWorkspace> {
  const slug = unique("ws").toLowerCase();
  const [t] = await sql<{ id: string }[]>`insert into tenants (slug, name) values (${slug}, ${name}) returning id`;
  const email = `admin@${slug}.test`;
  const admin = await withTenant(sql, t!.id, (tx) => insertUser(tx, t!.id, { email, displayName: "Admin", role: "admin" }));
  return { id: t!.id, slug, admin: { id: admin.id, email } };
}

export async function addUser(sql: Sql, ws: TestWorkspace, role: Role, email?: string) {
  const addr = email ?? `${unique(role)}@${ws.slug}.test`;
  return withTenant(sql, ws.id, (tx) => insertUser(tx, ws.id, { email: addr, displayName: role, role }));
}

/** Minimal HTTP client with a cookie jar. */
type Requester = { request: (path: string, init?: RequestInit) => Response | Promise<Response> };

export class Client {
  cookie = "";
  private readonly app: Requester;
  constructor(app: Requester) {
    this.app = app;
  }

  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const init: RequestInit = { method, headers: { ...headers }, redirect: "manual" };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)["content-type"] = "application/json";
    }
    if (this.cookie) (init.headers as Record<string, string>)["cookie"] = this.cookie;
    const res = await this.app.request(`http://localhost${path}`, init);
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(";");
      const [name, value] = pair!.split("=");
      const jar = new Map(
        this.cookie
          .split("; ")
          .filter(Boolean)
          .map((kv) => kv.split("=") as [string, string]),
      );
      if (!value || /max-age=0/i.test(sc) || /expires=thu, 01 jan 1970/i.test(sc)) jar.delete(name!);
      else jar.set(name!, value);
      this.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json, headers: res.headers };
  }

  get(path: string) {
    return this.req("GET", path);
  }
  post(path: string, body: unknown = {}) {
    return this.req("POST", path, body);
  }
  patch(path: string, body: unknown) {
    return this.req("PATCH", path, body);
  }
  delete(path: string) {
    return this.req("DELETE", path);
  }

  async signIn(email: string, workspace: string) {
    const res = await this.post("/auth/dev", { email, workspace });
    if (res.status !== 200) throw new Error(`sign-in failed: ${res.status} ${JSON.stringify(res.json)}`);
    return this;
  }
}

/** A project with one record type and a few fields, created through the admin API. */
export async function setupApProject(admin: Client, key = "FIN") {
  const p = await admin.post("/api/admin/projects", { key, name: "AP Requests" });
  if (p.status !== 201) throw new Error(JSON.stringify(p.json));
  const rt = await admin.post(`/api/admin/projects/${p.json.project.id}/record-types`, {
    key: "invoice_exception",
    name: "Invoice exception",
  });
  const recordTypeId = rt.json.recordType.id as string;
  const fields = [
    { key: "vendor", label: "Vendor", type: "text", required: true },
    { key: "amount", label: "Amount", type: "currency", options: { currency: "USD" } },
    {
      key: "reason",
      label: "Reason",
      type: "select",
      options: { choices: [{ value: "price", label: "Price mismatch" }, { value: "qty", label: "Quantity mismatch" }] },
      defaultValue: "price",
    },
  ];
  for (const f of fields) {
    const r = await admin.post(`/api/admin/record-types/${recordTypeId}/fields`, f);
    if (r.status !== 201) throw new Error(JSON.stringify(r.json));
  }
  return { projectId: p.json.project.id as string, recordTypeId };
}
