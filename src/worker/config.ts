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
  return {
    sessionSecret: e.TEND247_SESSION_SECRET,
    sessionTtlHours: e.TEND247_SESSION_TTL_HOURS ?? 24 * 14,
    devLogin: e.TEND247_DEV_LOGIN,
    oidc,
    requesterDomains: domains(e.TEND247_REQUESTER_DOMAINS),
    publicUrl: e.TEND247_PUBLIC_URL || null,
    publicSite: e.TEND247_PUBLIC_SITE,
    repoUrl: e.TEND247_REPO_URL || null,
  };
}
