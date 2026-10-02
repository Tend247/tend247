import { z } from "zod";

export type ProvisionRole = "off" | "agent" | "requester";

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  autoProvision: ProvisionRole;
  /** Email domains allowed to link to existing people or be provisioned. Empty = any (linking only). */
  allowedDomains: string[];
  /**
   * Link an existing person by email even when the provider does not assert email_verified
   * (Microsoft Entra ID omits it). Only safe with a single-tenant provider and allowedDomains set.
   */
  trustUnverifiedEmail: boolean;
}

export interface AppConfig {
  sessionSecret: string;
  sessionTtlHours: number;
  devLogin: boolean;
  oidc: OidcConfig | null;
  requesterDomains: string[];
  /** Absolute origin used in emailed links when the request origin is not trustworthy. */
  publicUrl: string | null;
  /** Serve the marketing pages (landing, roadmap, architecture) at /. Only tend247.com sets this. */
  publicSite: boolean;
  /** Public source repository shown on the marketing pages. */
  repoUrl: string | null;
  email: EmailConfig;
  /** Nightly export settings (the BACKUPS bucket binding enables it). */
  backup: { encryptionKey: string | null; dailyKeep: number; monthlyKeep: number };
  /** The public demo (tend247.com only): private sandboxes cloned from a golden copy. */
  demo: DemoConfig;
}

export interface DemoConfig {
  enabled: boolean;
  /** Cloudflare Turnstile keys guarding "Try the demo". */
  turnstileSiteKey: string | null;
  turnstileSecret: string | null;
  /** Ready-made sandboxes kept waiting so a visitor never waits for a copy. */
  poolSize: number;
  /** How long a sandbox lives. */
  hours: number;
  /** Most records a sandbox may hold. */
  maxRecords: number;
  /** Most sandboxes alive at once (a ceiling on what visitors can make the database hold). */
  maxSandboxes: number;
}

export interface EmailConfig {
  provider: "cloudflare" | "postmark" | "resend" | "none";
  /** From address, e.g. "Tend 24/7 <support@acme.com>". */
  from: string | null;
  apiKey: string | null;
  /** Domain that receives replies and queue mail (Cloudflare Email Routing), e.g. "help.acme.com". */
  inboundDomain: string | null;
  /** Which Authentication-Results header to trust: the one added by this receiving server. */
  inboundAuthservId: string;
}

const bool = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  TEND247_SESSION_SECRET: z.string().min(32, "TEND247_SESSION_SECRET must be at least 32 characters"),
  TEND247_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 90).optional(),
  TEND247_DEV_LOGIN: bool,
  TEND247_OIDC_ISSUER: z.string().url().optional().or(z.literal("")),
  TEND247_OIDC_CLIENT_ID: z.string().optional(),
  TEND247_OIDC_CLIENT_SECRET: z.string().optional(),
  TEND247_OIDC_AUTO_PROVISION: z.enum(["off", "agent", "requester"]).optional(),
  TEND247_OIDC_ALLOWED_DOMAINS: z.string().optional(),
  TEND247_OIDC_TRUST_UNVERIFIED_EMAIL: bool,
  TEND247_REQUESTER_DOMAINS: z.string().optional(),
  TEND247_PUBLIC_URL: z.string().url().optional().or(z.literal("")),
  TEND247_PUBLIC_SITE: bool,
  TEND247_REPO_URL: z.string().url().optional().or(z.literal("")),
  TEND247_EMAIL_PROVIDER: z.enum(["cloudflare", "postmark", "resend", "none", ""]).optional(),
  TEND247_EMAIL_FROM: z.string().max(300).optional(),
  TEND247_EMAIL_API_KEY: z.string().max(500).optional(),
  TEND247_INBOUND_DOMAIN: z
    .string()
    .regex(/^([a-z0-9-]+\.)+[a-z]{2,}$/i, "TEND247_INBOUND_DOMAIN must be a domain name")
    .optional()
    .or(z.literal("")),
  TEND247_INBOUND_AUTHSERV_ID: z.string().max(200).optional(),
  TEND247_BACKUP_ENCRYPTION_KEY: z
    .string()
    .refine((v) => v === "" || /^[A-Za-z0-9+/_-]{43}=?$/.test(v), "TEND247_BACKUP_ENCRYPTION_KEY must be 32 bytes, base64")
    .optional(),
  TEND247_BACKUP_DAILY_KEEP: z.coerce.number().int().min(1).max(365).optional(),
  TEND247_BACKUP_MONTHLY_KEEP: z.coerce.number().int().min(0).max(120).optional(),
  TEND247_DEMO: bool,
  TEND247_TURNSTILE_SITE_KEY: z.string().max(200).optional(),
  TEND247_TURNSTILE_SECRET: z.string().max(200).optional(),
  TEND247_DEMO_POOL_SIZE: z.coerce.number().int().min(0).max(50).optional(),
  TEND247_DEMO_HOURS: z.coerce.number().int().min(1).max(24).optional(),
  TEND247_DEMO_MAX_RECORDS: z.coerce.number().int().min(20).max(5000).optional(),
  TEND247_DEMO_MAX_SANDBOXES: z.coerce.number().int().min(1).max(100_000).optional(),
});

/** Parse configuration from Worker bindings or process.env; throws a readable error. */
export function loadConfig(env: Record<string, unknown>): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid Tend 24/7 configuration: ${msg}`);
  }
  const e = parsed.data;
  const domains = (v: string | undefined) =>
    (v ?? "")
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
  const oidc: OidcConfig | null =
    e.TEND247_OIDC_ISSUER && e.TEND247_OIDC_CLIENT_ID
      ? {
          issuer: e.TEND247_OIDC_ISSUER,
          clientId: e.TEND247_OIDC_CLIENT_ID,
          clientSecret: e.TEND247_OIDC_CLIENT_SECRET ?? "",
          autoProvision: e.TEND247_OIDC_AUTO_PROVISION ?? "off",
          allowedDomains: domains(e.TEND247_OIDC_ALLOWED_DOMAINS),
          trustUnverifiedEmail: e.TEND247_OIDC_TRUST_UNVERIFIED_EMAIL,
        }
      : null;
  if (oidc && oidc.autoProvision !== "off" && oidc.allowedDomains.length === 0) {
    throw new Error("Invalid Tend 24/7 configuration: TEND247_OIDC_AUTO_PROVISION needs TEND247_OIDC_ALLOWED_DOMAINS");
  }
  if (oidc && oidc.trustUnverifiedEmail && oidc.allowedDomains.length === 0) {
    throw new Error("Invalid Tend 24/7 configuration: TEND247_OIDC_TRUST_UNVERIFIED_EMAIL needs TEND247_OIDC_ALLOWED_DOMAINS");
  }
  const provider = (e.TEND247_EMAIL_PROVIDER || "none") as EmailConfig["provider"];
  if (provider !== "none" && !e.TEND247_EMAIL_FROM) {
    throw new Error("Invalid Tend 24/7 configuration: TEND247_EMAIL_PROVIDER needs TEND247_EMAIL_FROM");
  }
  if ((provider === "postmark" || provider === "resend") && !e.TEND247_EMAIL_API_KEY) {
    throw new Error(`Invalid Tend 24/7 configuration: TEND247_EMAIL_PROVIDER=${provider} needs TEND247_EMAIL_API_KEY`);
  }
  if (e.TEND247_DEMO && !e.TEND247_DEV_LOGIN && (!e.TEND247_TURNSTILE_SITE_KEY || !e.TEND247_TURNSTILE_SECRET)) {
    throw new Error("Invalid Tend 24/7 configuration: TEND247_DEMO needs TEND247_TURNSTILE_SITE_KEY and TEND247_TURNSTILE_SECRET");
  }
  return {
    sessionSecret: e.TEND247_SESSION_SECRET,
    sessionTtlHours: e.TEND247_SESSION_TTL_HOURS ?? 24 * 14,
    devLogin: e.TEND247_DEV_LOGIN,
    oidc,
    requesterDomains: domains(e.TEND247_REQUESTER_DOMAINS),
    publicUrl: e.TEND247_PUBLIC_URL || null,
    publicSite: e.TEND247_PUBLIC_SITE,
    repoUrl: e.TEND247_REPO_URL || null,
    email: {
      provider,
      from: e.TEND247_EMAIL_FROM || null,
      apiKey: e.TEND247_EMAIL_API_KEY || null,
      inboundDomain: e.TEND247_INBOUND_DOMAIN ? e.TEND247_INBOUND_DOMAIN.toLowerCase() : null,
      inboundAuthservId: e.TEND247_INBOUND_AUTHSERV_ID || "mx.cloudflare.net",
    },
    backup: {
      encryptionKey: e.TEND247_BACKUP_ENCRYPTION_KEY || null,
      dailyKeep: e.TEND247_BACKUP_DAILY_KEEP ?? 14,
      monthlyKeep: e.TEND247_BACKUP_MONTHLY_KEEP ?? 12,
    },
    demo: {
      enabled: e.TEND247_DEMO,
      turnstileSiteKey: e.TEND247_TURNSTILE_SITE_KEY || null,
      turnstileSecret: e.TEND247_TURNSTILE_SECRET || null,
      poolSize: e.TEND247_DEMO_POOL_SIZE ?? 3,
      hours: e.TEND247_DEMO_HOURS ?? 24,
      maxRecords: e.TEND247_DEMO_MAX_RECORDS ?? 300,
      maxSandboxes: e.TEND247_DEMO_MAX_SANDBOXES ?? 1000,
    },
  };
}
