import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { parseConfig } from "./src/lib/config";
import { buildHeadersFile } from "./src/csp";

/** Writes Cloudflare Pages `_headers` (strict CSP from the same env the bundle uses; bad config fails the build). */
function headersPlugin(env: Record<string, string>): Plugin {
  return {
    name: "admin-headers",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "_headers", source: buildHeadersFile(parseConfig(env)) });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  return {
    plugins: [react(), headersPlugin(env)],
    build: { sourcemap: false, modulePreload: { polyfill: false }, chunkSizeWarningLimit: 2000 },
  };
});
