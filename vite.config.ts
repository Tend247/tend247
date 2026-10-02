import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

// TEND247_WRANGLER_CONFIG picks the Worker configuration to build for: wrangler.jsonc for a
// self-hosted deployment (the default), wrangler.tend247.jsonc for tend247.com and its demo.
export default defineConfig({
  plugins: [react(), cloudflare({ configPath: process.env.TEND247_WRANGLER_CONFIG ?? "wrangler.jsonc" })],
});
