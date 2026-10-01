// Generic OpenID Connect sign-in (authorization code + PKCE) for staff, using the
// company's own identity provider: Okta, Microsoft Entra ID, Google Workspace, Keycloak...
import * as oauth from "oauth4webapi";
import type { OidcConfig } from "../config.ts";

export type FetchLike = typeof fetch;

export interface OidcStart {
  url: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface OidcIdentity {
  subject: string;
  email: string;
  /** True only when the provider explicitly asserts email_verified: true. */
  emailVerified: boolean;
  name: string;
}

const discoveryCache = new Map<string, Promise<oauth.AuthorizationServer>>();

function discover(cfg: OidcConfig, fetchImpl?: FetchLike): Promise<oauth.AuthorizationServer> {
  const key = cfg.issuer;
  let cached = discoveryCache.get(key);
  if (!cached) {
    const issuer = new URL(cfg.issuer);
    cached = oauth
      .discoveryRequest(issuer, { algorithm: "oidc", ...(fetchImpl ? { [oauth.customFetch]: fetchImpl } : {}) })
      .then((res) => oauth.processDiscoveryResponse(issuer, res));
    cached.catch(() => discoveryCache.delete(key));
    discoveryCache.set(key, cached);
  }
  return cached;
}

/** Test hook: forget cached discovery documents. */
export function resetOidcCache(): void {
  discoveryCache.clear();
}

export async function startOidc(cfg: OidcConfig, redirectUri: string, fetchImpl?: FetchLike): Promise<OidcStart> {
  const as = await discover(cfg, fetchImpl);
  if (!as.authorization_endpoint) throw new Error("OIDC provider has no authorization endpoint");
  const codeVerifier = oauth.generateRandomCodeVerifier();
  const state = oauth.generateRandomState();
  const nonce = oauth.generateRandomNonce();
  const url = new URL(as.authorization_endpoint);
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("code_challenge", await oauth.calculatePKCECodeChallenge(codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  return { url: url.toString(), state, nonce, codeVerifier };
}

export async function finishOidc(
  cfg: OidcConfig,
  input: { currentUrl: URL; redirectUri: string; state: string; nonce: string; codeVerifier: string },
  fetchImpl?: FetchLike,
): Promise<OidcIdentity> {
  const as = await discover(cfg, fetchImpl);
  const client: oauth.Client = { client_id: cfg.clientId };
  const clientAuth = cfg.clientSecret ? oauth.ClientSecretPost(cfg.clientSecret) : oauth.None();
  const params = oauth.validateAuthResponse(as, client, input.currentUrl, input.state);
  const response = await oauth.authorizationCodeGrantRequest(
    as,
    client,
    clientAuth,
    params,
    input.redirectUri,
    input.codeVerifier,
    fetchImpl ? { [oauth.customFetch]: fetchImpl } : {},
  );
  const result = await oauth.processAuthorizationCodeResponse(as, client, response, {
    expectedNonce: input.nonce,
    requireIdToken: true,
  });
  const claims = oauth.getValidatedIdTokenClaims(result);
  if (!claims) throw new Error("OIDC provider returned no ID token");
  const email = typeof claims.email === "string" ? claims.email.toLowerCase() : "";
  if (!email) throw new Error("OIDC provider did not return an email claim; request the 'email' scope");
  const raw = typeof claims.name === "string" && claims.name.trim() ? claims.name.trim() : email;
  return { subject: claims.sub, email, emailVerified: claims.email_verified === true, name: raw.slice(0, 200) };
}
