// The installer's pure parts: connection strings, config patching, output parsing, the plan.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { appUrlFrom, parseHyperdriveId, planSetup, setHyperdriveId, setJsoncVar, slugify } from "../scripts/setup.ts";
import { loadConfig } from "../src/worker/config.ts";

const wrangler = readFileSync("wrangler.jsonc", "utf8");

describe("npm run setup", () => {
  it("derives the app role URL from the owner URL, escaping the password", () => {
    const url = appUrlFrom("postgres://tend247_owner:o%40wner@db.example.com:5432/tend247?sslmode=verify-full", "tend247_app", "p@ss/word");
    expect(url).toBe("postgres://tend247_app:p%40ss%2Fword@db.example.com:5432/tend247?sslmode=verify-full");
  });

  it("patches vars and the Hyperdrive id in wrangler.jsonc without touching comments", () => {
    let text = setJsoncVar(wrangler, "TEND247_EMAIL_PROVIDER", "resend");
    text = setJsoncVar(text, "TEND247_EMAIL_FROM", 'Help "desk" <help@acme.com>');
    text = setHyperdriveId(text, "0123456789abcdef0123456789abcdef");
    expect(text).toContain('"TEND247_EMAIL_PROVIDER": "resend"');
    expect(text).toContain('"TEND247_EMAIL_FROM": "Help \\"desk\\" <help@acme.com>"');
    expect(text).toContain('"id": "0123456789abcdef0123456789abcdef"');
    expect(text).toContain("// Create with caching DISABLED");
    expect(() => setJsoncVar(text, "TEND247_NOPE", "x")).toThrow(/not in the Worker config/);
    expect(() => setHyperdriveId(text, "nope")).toThrow();
  });

  it("the self-hosted wrangler.jsonc vars load as a valid configuration", () => {
    const vars = JSON.parse(/"vars"\s*:\s*(\{[\s\S]*?\n\s*\})/.exec(wrangler)![1]!.replace(/\/\/.*$/gm, "")) as Record<string, string>;
    expect(() => loadConfig({ ...vars, TEND247_SESSION_SECRET: "x".repeat(40) })).not.toThrow();
  });

  it("reads the Hyperdrive id from wrangler output", () => {
    expect(parseHyperdriveId('✅ Created new Hyperdrive config: {\n  "id": "0123456789abcdef0123456789abcdef",\n  "name": "tend247-db"')).toBe("0123456789abcdef0123456789abcdef");
    expect(parseHyperdriveId("nothing here")).toBeNull();
  });

  it("plans every step and never prints the database password", () => {
    const steps = planSetup({
      ownerUrl: "postgres://tend247_owner:supersecret@db.example.com/tend247",
      workspaceName: "Acme",
      workspaceSlug: slugify("Acme Foods, Inc."),
      adminEmail: "it@acme.com",
      adminName: "IT",
      signIn: "oidc",
      config: "wrangler.jsonc",
    });
    expect(steps.map((s) => s.title.split(" ")[0])).toEqual(["Check", "Migrate", "Create", "Create", "Configure", "Create", "Build", "Set"]);
    expect(JSON.stringify(steps)).not.toContain("supersecret");
    expect(steps[5]!.title).toContain("acme-foods-inc");
  });
});
