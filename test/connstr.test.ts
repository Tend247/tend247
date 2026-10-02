// Connection strings copied from provider dashboards (libpq style) work with postgres.js.
import { describe, expect, it } from "vitest";
import { normalizeConnectionString } from "../src/worker/db/connstr.ts";
import { createSql } from "../src/worker/db/client.ts";
import { appUrlFrom } from "../scripts/setup.ts";
import { OWNER_URL } from "./setup/env.ts";

const n = (url: string) => normalizeConnectionString(url);

describe("connection strings", () => {
  it("turns sslrootcert=system into verify-full instead of sending it to the server", () => {
    expect(n("postgres://u:p@db.example.com:5432/app?sslmode=verify-full&sslrootcert=system")).toEqual({
      url: "postgres://u:p@db.example.com:5432/app?sslmode=verify-full",
      caFile: null,
      dropped: [],
    });
    expect(n("postgresql://u:p@h/app?sslrootcert=system").url).toBe("postgresql://u:p@h/app?sslmode=verify-full");
    expect(n("postgres://u:p@h/app?sslmode=require&sslrootcert=system").url).toBe("postgres://u:p@h/app?sslmode=verify-full");
  });

  it("keeps a CA file for the caller and verifies against it", () => {
    expect(n("postgres://u:p@h/app?sslmode=verify-ca&sslrootcert=/etc/ssl/prod-ca.crt")).toEqual({
      url: "postgres://u:p@h/app?sslmode=verify-ca",
      caFile: "/etc/ssl/prod-ca.crt",
      dropped: [],
    });
    expect(n("postgres://u:p@h/app?sslrootcert=ca.pem").url).toBe("postgres://u:p@h/app?sslmode=verify-full");
  });

  it("drops other client-only options and reports them", () => {
    const r = n("postgres://u:p@h/app?sslmode=require&channel_binding=require&gssencmode=disable&application_name=tend");
    expect(r.url).toBe("postgres://u:p@h/app?sslmode=require&application_name=tend");
    expect(r.dropped).toEqual(["channel_binding", "gssencmode"]);
  });

  it("leaves ordinary URLs and non-URLs alone", () => {
    for (const url of ["postgres://u:p@h/app", "postgres://u:p@h/app?sslmode=require", "not a url"]) expect(n(url).url).toBe(url);
    expect(n("postgres://u:p@h/app?sslmode=disable&sslrootcert=system").url).toBe("postgres://u:p@h/app?sslmode=disable");
  });

  it("the app role's URL for Hyperdrive carries no client-only options", () => {
    expect(appUrlFrom("postgres://owner:x@h.example.com/app?sslmode=verify-full&sslrootcert=system", "tend247_app", "s3cr3t/+=")).toBe(
      "postgres://tend247_app:s3cr3t%2F%2B%3D@h.example.com/app?sslmode=verify-full",
    );
  });

  it("connects with a dashboard-style URL", async () => {
    const u = new URL(OWNER_URL);
    u.searchParams.set("sslmode", "disable");
    u.searchParams.set("sslrootcert", "system");
    u.searchParams.set("channel_binding", "prefer");
    const sql = createSql(u.toString(), { max: 1 });
    try {
      const [row] = await sql<{ ok: number }[]>`select 1 as ok`;
      expect(row!.ok).toBe(1);
    } finally {
      await sql.end();
    }
  });
});
