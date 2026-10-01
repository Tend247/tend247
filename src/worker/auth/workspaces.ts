import type { Db } from "../db/client.ts";

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  demo: boolean;
  expiresAt: Date | null;
}

/**
 * Find the workspace to sign in to. A deployment belongs to one company, so without a slug
 * the oldest non-demo workspace is used. Expired workspaces are never returned.
 */
export async function resolveWorkspace(sql: Db, slug?: string | null): Promise<Workspace | null> {
  const rows = slug
    ? await sql<Workspace[]>`
        select id, slug, name, demo, expires_at from tenants
        where slug = ${slug} and (expires_at is null or expires_at > now())`
    : await sql<Workspace[]>`
        select id, slug, name, demo, expires_at from tenants
        where not demo and (expires_at is null or expires_at > now())
        order by created_at asc limit 1`;
  return rows[0] ?? null;
}
