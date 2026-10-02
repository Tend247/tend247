// npm run setup — install Tend 24/7 into your Cloudflare account and Postgres, start to finish.
//
//   npm run setup                 interactive
//   npm run setup -- --dry-run    print every step and command, change nothing
//
// Steps: check wrangler is signed in; migrate the database as the schema owner and create
// (or re-key) the locked-down app role; create a Hyperdrive config with caching disabled and
// write its id into wrangler.jsonc; create the R2 bucket; set how people sign in; create the
// first workspace and admin; build and deploy; set the Worker secrets.
//
// Every value can come from a flag or the environment (.env) instead of a prompt:
//   --db-owner-url / TEND247_DB_OWNER_URL     the schema owner's direct connection string
//   --workspace-name, --workspace-slug        the first workspace
//   --admin-email, --admin-name               its first admin
//   --sign-in oidc|email                      how staff sign in
//   --oidc-issuer, --oidc-client-id, --oidc-domains   (client secret: TEND247_OIDC_CLIENT_SECRET)
//   --email-provider resend|postmark, --email-from    (API key: TEND247_EMAIL_API_KEY)
// Prefer the environment (or .env) for secrets so they stay out of shell history. Note that
// `wrangler hyperdrive create` takes the app role's connection string on its command line.
//   --public-url                              e.g. https://help.acme.com (optional)
//   --config wrangler.jsonc                   which Worker config to patch and deploy
//   --yes                                     accept defaults, never prompt
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { base64url } from "../src/worker/lib/crypto.ts";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { loadDotEnv } from "./lib/dotenv.ts";
import { parseArgs, str } from "./lib/args.ts";
import { normalizeConnectionString, readCaFile } from "../src/worker/db/connstr.ts";

// ---------------------------------------------------------------- pure helpers (tested)

/**
 * The app role's connection string: the owner's URL with another user and password, without
 * libpq-only client options (Hyperdrive and postgres.js read sslmode, not sslrootcert).
 */
export function appUrlFrom(ownerUrl: string, role: string, password: string): string {
  const u = new URL(normalizeConnectionString(ownerUrl).url);
  u.username = encodeURIComponent(role);
  u.password = encodeURIComponent(password);
  return u.toString();
}

/** Replace the value of a string var in a wrangler.jsonc file, keeping comments and layout. */
export function setJsoncVar(text: string, key: string, value: string): string {
  const re = new RegExp(`("${key}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`);
  if (!re.test(text)) throw new Error(`${key} is not in the Worker config; add it under "vars" first`);
  return text.replace(re, `$1${JSON.stringify(value)}`);
}

/** Put the Hyperdrive id in place of the placeholder (or a previous id) for the HYPERDRIVE binding. */
export function setHyperdriveId(text: string, id: string): string {
  if (!/^[0-9a-f]{32}$/.test(id)) throw new Error(`Not a Hyperdrive id: ${id}`);
  const re = /("binding"\s*:\s*"HYPERDRIVE"[\s\S]*?"id"\s*:\s*)"[0-9a-f]{32}"/;
  if (!re.test(text)) throw new Error("Could not find the HYPERDRIVE binding's id in the Worker config");
  return text.replace(re, `$1"${id}"`);
}

/** Find the id in `wrangler hyperdrive create` output (text or JSON). */
export function parseHyperdriveId(output: string): string | null {
  return /"id"\s*:\s*"([0-9a-f]{32})"/.exec(output)?.[1] ?? /\b([0-9a-f]{32})\b/.exec(output)?.[1] ?? null;
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "workspace"
  );
}

export interface SetupInput {
  ownerUrl: string;
  workspaceName: string;
  workspaceSlug: string;
  adminEmail: string;
  adminName: string;
  signIn: "oidc" | "email";
  oidc?: { issuer: string; clientId: string; clientSecret: string; domains: string };
  email?: { provider: "resend" | "postmark"; apiKey: string; from: string };
  publicUrl?: string;
  config: string;
}

export interface Step {
  title: string;
  /** Shell commands this step runs (secrets masked). */
  commands: string[];
}

const random = (bytes: number) => crypto.getRandomValues(new Uint8Array(bytes));
const randomB64 = (bytes: number) => btoa(String.fromCharCode(...random(bytes)));

const mask = (s: string) => s.replace(/(postgres(?:ql)?:\/\/[^:]+:)[^@]+@/g, "$1••••@");

/** What setup will do, in order; --dry-run prints this and stops. */
export function planSetup(input: SetupInput): Step[] {
  const cfg = `--config ${input.config}`;
  return [
    { title: "Check that wrangler is signed in to Cloudflare", commands: ["npx wrangler whoami"] },
    {
      title: "Migrate the database as the schema owner; create or re-key the app role tend247_app (no BYPASSRLS)",
      commands: [mask(`migrate ${input.ownerUrl}`)],
    },
    {
      title: "Create a Hyperdrive config with query caching disabled and write its id into the Worker config",
      commands: ["npx wrangler hyperdrive create tend247-db --connection-string=<app role URL> --caching-disabled"],
    },
    { title: "Create the R2 bucket for attachments", commands: ["npx wrangler r2 bucket create tend247-attachments"] },
    {
      title: `Configure sign-in (${input.signIn === "oidc" ? "single sign-on" : `email links via ${input.email?.provider ?? "an email provider"}`})`,
      commands: [`edit ${input.config} vars`],
    },
    {
      title: `Create the workspace "${input.workspaceName}" (${input.workspaceSlug}) with admin ${input.adminEmail}`,
      commands: ["insert into tenants, users"],
    },
    { title: "Build and deploy the Worker", commands: [`TEND247_WRANGLER_CONFIG=${input.config} npm run build`, "npx wrangler deploy   (the build's output config)"] },
    {
      title: "Set the Worker secrets (session key, backup key, SSO or email credentials)",
      commands: [`npx wrangler secret bulk ${cfg}   (JSON on stdin)`],
    },
  ];
}

// ---------------------------------------------------------------- the installer

function run(cmd: string, args: string[], opts: { input?: string; quiet?: boolean; env?: NodeJS.ProcessEnv } = {}): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    input: opts.input,
    env: opts.env ?? process.env,
    stdio: [opts.input ? "pipe" : "inherit", "pipe", "pipe"],
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (!opts.quiet) process.stdout.write(mask(out));
  return { ok: r.status === 0, out };
}

async function main(): Promise<void> {
  if (process.platform === "win32") {
    throw new Error("Run setup from macOS, Linux or WSL (connection strings with & are not safe to pass through cmd.exe).");
  }
  loadDotEnv();
  const { flags } = parseArgs(process.argv.slice(2));
  const dryRun = flags["dry-run"] === true;
  const yes = flags.yes === true;
  const rl = yes ? null : createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string, fallback = ""): Promise<string> => {
    if (!rl) return fallback;
    const a = (await rl.question(`${q}${fallback ? ` [${fallback}]` : ""}: `)).trim();
    return a || fallback;
  };
  const need = (v: string | undefined, what: string): string => {
    if (!v) throw new Error(`Missing ${what}`);
    return v;
  };
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const config = str(flags.config) ?? "wrangler.jsonc";

  try {
    console.log("Tend 24/7 setup" + (dryRun ? " (dry run: nothing will change)" : "") + "\n");
    const ownerUrl = need(str(flags["db-owner-url"]) ?? process.env.TEND247_DB_OWNER_URL ?? (await ask("Schema owner connection string (postgres://...)")), "the database owner URL (--db-owner-url)");
    const workspaceName = str(flags["workspace-name"]) ?? (await ask("Company or workspace name", "My Company"));
    const workspaceSlug = str(flags["workspace-slug"]) ?? (await ask("Workspace slug", slugify(workspaceName)));
    const adminEmail = need(str(flags["admin-email"]) ?? (await ask("First admin's email")), "the admin email (--admin-email)").toLowerCase();
    const adminName = str(flags["admin-name"]) ?? (await ask("First admin's name", adminEmail.split("@")[0]));
    const signIn = (str(flags["sign-in"]) ?? (await ask("How will staff sign in: oidc (single sign-on) or email (one-time links)", "oidc"))) as "oidc" | "email";
    const input: SetupInput = { ownerUrl, workspaceName, workspaceSlug, adminEmail, adminName, signIn, config, publicUrl: str(flags["public-url"]) };
    if (signIn === "oidc") {
      input.oidc = {
        issuer: need(str(flags["oidc-issuer"]) ?? (await ask("OIDC issuer URL (e.g. https://login.microsoftonline.com/<tenant>/v2.0)")), "--oidc-issuer"),
        clientId: need(str(flags["oidc-client-id"]) ?? (await ask("OIDC client id")), "--oidc-client-id"),
        clientSecret: need(str(flags["oidc-client-secret"]) ?? process.env.TEND247_OIDC_CLIENT_SECRET ?? (await ask("OIDC client secret")), "--oidc-client-secret or TEND247_OIDC_CLIENT_SECRET"),
        domains: str(flags["oidc-domains"]) ?? (await ask("Email domains allowed to sign in, comma-separated", adminEmail.split("@")[1])),
      };
    } else {
      input.email = {
        provider: (str(flags["email-provider"]) ?? (await ask("Email provider: resend or postmark", "resend"))) as "resend" | "postmark",
        apiKey: need(str(flags["email-api-key"]) ?? process.env.TEND247_EMAIL_API_KEY ?? (await ask("Email provider API key")), "--email-api-key or TEND247_EMAIL_API_KEY"),
        from: need(str(flags["email-from"]) ?? (await ask('From address, e.g. "Help desk <help@acme.com>"')), "--email-from"),
      };
    }

    const steps = planSetup(input);
    if (dryRun) {
      steps.forEach((s, i) => {
        console.log(`${i + 1}. ${s.title}`);
        for (const c of s.commands) console.log(`     $ ${c}`);
      });
      console.log("\nDry run complete. Run without --dry-run to install.");
      return;
    }

    // 1. wrangler
    console.log(`\n1. ${steps[0]!.title}`);
    if (!run("npx", ["wrangler", "whoami"]).ok) throw new Error("Run `npx wrangler login` first.");

    // 2. database
    console.log(`\n2. ${steps[1]!.title}`);
    const { migrate } = await import("./lib/migrator.ts");
    const appPassword = process.env.TEND247_DB_APP_PASSWORD || base64url(random(24));
    await migrate({ ownerUrl, migrationsDir: join(root, "migrations"), appRole: "tend247_app", appPassword, log: (l) => console.log(`   ${l}`) });
    const postgres = (await import("postgres")).default;
    const ownerConn = normalizeConnectionString(ownerUrl);
    const owner = postgres(ownerConn.url, {
      max: 1,
      onnotice: () => {},
      ...(ownerConn.caFile ? { ssl: { ca: readCaFile(ownerConn.caFile), rejectUnauthorized: true } } : {}),
    });
    try {
      // migrate() only sets a password when it creates the role; re-key an existing one so the
      // URL below is right.
      const { scramVerifier } = await import("./lib/migrator.ts");
      if (!process.env.TEND247_DB_APP_PASSWORD) {
        await owner.unsafe(`alter role tend247_app password '${scramVerifier(appPassword)}'`).catch((err: Error) => {
          throw new Error(
            `the role tend247_app already exists and this owner cannot change its password (${err.message}). ` +
              "Set TEND247_DB_APP_PASSWORD to its current password and run setup again.",
          );
        });
      }
    } finally {
      await owner.end();
    }
    const appUrl = appUrlFrom(ownerUrl, "tend247_app", appPassword);
    const { createSql, withTenant } = await import("../src/worker/db/client.ts");
    const { checkDatabase } = await import("../src/worker/db/checks.ts");
    const app = createSql(appUrl, { max: 1 });
    try {
      const check = await checkDatabase(app);
      if (!check.ok) throw new Error(`The app role is not safe to use: ${check.problems.join("; ")}`);
      console.log("   app role connects, cannot bypass row-level security, and does not own the schema");
    } finally {
      await app.end();
    }

    // 3. Hyperdrive
    console.log(`\n3. ${steps[2]!.title}`);
    let text = readFileSync(join(root, config), "utf8");
    let hyperdriveId = str(flags["hyperdrive-id"]) ?? null;
    if (!hyperdriveId) {
      const r = run("npx", ["wrangler", "hyperdrive", "create", "tend247-db", `--connection-string=${appUrl}`, "--caching-disabled"], { quiet: true });
      process.stdout.write(mask(r.out));
      hyperdriveId = r.ok ? parseHyperdriveId(r.out) : null;
      if (!hyperdriveId) throw new Error("Could not create the Hyperdrive config. If one named tend247-db exists, rerun with --hyperdrive-id <id>.");
    }
    text = setHyperdriveId(text, hyperdriveId);

    // 4. R2
    console.log(`\n4. ${steps[3]!.title}`);
    const bucket = run("npx", ["wrangler", "r2", "bucket", "create", "tend247-attachments"], { quiet: true });
    console.log(bucket.ok ? "   created tend247-attachments" : /already exists|already own/i.test(bucket.out) ? "   tend247-attachments already exists" : mask(bucket.out));

    // 5. sign-in settings
    console.log(`\n5. ${steps[4]!.title}`);
    const secrets: Record<string, string> = {
      TEND247_SESSION_SECRET: base64url(random(36)),
      TEND247_BACKUP_ENCRYPTION_KEY: randomB64(32),
    };
    text = setJsoncVar(text, "TEND247_DEV_LOGIN", "false");
    if (input.publicUrl) text = setJsoncVar(text, "TEND247_PUBLIC_URL", input.publicUrl);
    if (input.oidc) {
      text = setJsoncVar(text, "TEND247_OIDC_ISSUER", input.oidc.issuer);
      text = setJsoncVar(text, "TEND247_OIDC_CLIENT_ID", input.oidc.clientId);
      text = setJsoncVar(text, "TEND247_OIDC_ALLOWED_DOMAINS", input.oidc.domains);
      secrets.TEND247_OIDC_CLIENT_SECRET = input.oidc.clientSecret;
    }
    if (input.email) {
      text = setJsoncVar(text, "TEND247_EMAIL_PROVIDER", input.email.provider);
      text = setJsoncVar(text, "TEND247_EMAIL_FROM", input.email.from);
      secrets.TEND247_EMAIL_API_KEY = input.email.apiKey;
    }
    writeFileSync(join(root, config), text);
    console.log(`   wrote ${config}`);

    // 6. first workspace
    console.log(`\n6. ${steps[5]!.title}`);
    const { insertUser } = await import("../src/worker/users/service.ts");
    const db = createSql(ownerUrl, { max: 1 });
    try {
      const [existing] = await db<{ id: string }[]>`select id from tenants where not demo limit 1`;
      if (existing) {
        console.log("   a workspace already exists; skipping");
      } else {
        const [t] = await db<{ id: string }[]>`insert into tenants (slug, name) values (${workspaceSlug}, ${workspaceName}) returning id`;
        await withTenant(db, t!.id, (tx) => insertUser(tx, t!.id, { email: adminEmail, displayName: adminName, role: "admin" }));
        console.log(`   created ${workspaceSlug} with admin ${adminEmail}`);
      }
    } finally {
      await db.end();
    }

    // 7. deploy, 8. secrets
    console.log(`\n7. ${steps[6]!.title}`);
    if (!run("npm", ["run", "build"], { env: { ...process.env, TEND247_WRANGLER_CONFIG: config } }).ok) throw new Error("The build failed");
    const deploy = run("npx", ["wrangler", "deploy"]);
    if (!deploy.ok) throw new Error("wrangler deploy failed");
    console.log(`\n8. ${steps[7]!.title}`);
    if (!run("npx", ["wrangler", "secret", "bulk", "--config", config], { input: JSON.stringify(secrets) }).ok) {
      throw new Error("Setting secrets failed; set them with `npx wrangler secret put <NAME>`");
    }

    const url = /https:\/\/[^\s]+\.workers\.dev/.exec(deploy.out)?.[0] ?? input.publicUrl ?? "(see the deploy output above)";
    console.log(`
Done. Tend 24/7 is live at ${url}

Keep this backup encryption key somewhere safe (a password manager). You need it to read the
nightly exports, and it is not stored anywhere else you can see:

  ${secrets.TEND247_BACKUP_ENCRYPTION_KEY}

Next: sign in as ${adminEmail}, install a starter template under Admin > Projects, and bind a
BACKUPS bucket for nightly exports (docs/restore.md).`);
  } finally {
    rl?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: Error) => {
    console.error(`\nSetup stopped: ${mask(err.message)}`);
    process.exit(1);
  });
}
