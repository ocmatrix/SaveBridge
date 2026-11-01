import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { parseConfig } from "./src/config";
import { buildHeadersFile } from "./src/csp";

/** Writes Cloudflare Pages `_headers` (strict CSP built from the same env the bundle uses). */
function headersPlugin(env: Record<string, string>): Plugin {
  return {
    name: "bridge-headers",
    apply: "build",
    generateBundle() {
      const cfg = parseConfig(env); // fails the build on a bad/missing config
      this.emitFile({ type: "asset", fileName: "_headers", source: buildHeadersFile(cfg) });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  return {
    plugins: [react(), headersPlugin(env)],
    build: {
      sourcemap: false,
      modulePreload: { polyfill: false }, // no inline/polyfill script
      chunkSizeWarningLimit: 2000,
    },
  };
});
