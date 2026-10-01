// Build flag for the static marketing site (tend247.com): `npm run site:build` sets it, and
// the bundle then renders only the landing, roadmap and architecture pages, with no API calls.
export const SITE_ONLY = import.meta.env.VITE_SITE_ONLY === "1";
export const SITE_REPO_URL: string | null = import.meta.env.VITE_REPO_URL || null;
