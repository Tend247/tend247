# Security policy

## Reporting a vulnerability

Please report vulnerabilities **privately**: use GitHub's "Report a vulnerability" (Security > Advisories) on this repository, or email security@tend247.com. Don't open a public issue.

Include what you found, how to reproduce it, and what an attacker could do with it. We aim to:

- acknowledge reports within 3 working days;
- tell you our assessment within 10;
- fix confirmed issues as fast as their severity calls for, and credit you in the release notes if you'd like.

## Supported versions

Security fixes go into the latest release. Self-hosted deployments should stay current (`git pull`, `npm run db:migrate`, deploy).

## Scope

In scope:
- this repository's code;
- the public demo at tend247.com.

For the demo, please:
- stay within your own sandbox;
- do no load testing or denial of service;
- don't touch other visitors' data.

Especially interesting:
- anything that crosses workspaces (row-level security);
- escapes from a read-only phone session or an API token's scopes;
- authentication and session handling;
- the email and webhook paths.

Out of scope: findings that need a compromised Cloudflare account or database owner credentials, and missing hardening headers on third-party pages.

## How Tend 24/7 is built to be safe

- **Workspace isolation:**
  - FORCE'd row-level security on every workspace table, keyed on a transaction-local setting;
  - the app refuses to start on a role that is a superuser, has `BYPASSRLS` or owns the schema;
  - the scripts refuse an owner that can bypass row-level security.
- **Stored secrets:** sessions, API tokens, sign-in links, approval links and phone pairings store only hashes of their secrets.
- **Credentials and links in transit:** one-time links carry their token in the URL fragment, so it never reaches server logs. Cookies use the `__Host-` prefix over HTTPS.
- **Cross-site requests:** unsafe methods require JSON, and the browser's cross-site markers are refused.
- **Phone sessions:** read-only, limited by a server-side allowlist of routes.
- **API tokens:** each scope maps to an allowlist of routes.
- **Audit:** an append-only `audit_log` covers configuration, tokens, imports, exports and devices.
