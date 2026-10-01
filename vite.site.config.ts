// Static build of the marketing site (landing, roadmap, architecture) for tend247.com.
//   npm run site:build   → dist-site/
//   npm run site:deploy  → Cloudflare (wrangler.site.jsonc)
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  define: {
    "import.meta.env.VITE_SITE_ONLY": JSON.stringify("1"),
    "import.meta.env.VITE_REPO_URL": JSON.stringify(process.env.VITE_REPO_URL ?? "https://github.com/Tend247/tend247"),
  },
  publicDir: "site-public",
  build: { outDir: "dist-site", emptyOutDir: true },
});
