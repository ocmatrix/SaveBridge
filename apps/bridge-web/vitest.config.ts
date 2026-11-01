import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    globalSetup: ["./test/globalSetup.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    projects: [
      { extends: true, test: { name: "unit", include: ["test/unit/**/*.test.ts"], environment: "node" } },
      { extends: true, test: { name: "integration", include: ["test/integration/**/*.test.ts"], environment: "node" } },
      {
        extends: true,
        test: { name: "component", include: ["test/component/**/*.test.tsx"], environment: "jsdom", setupFiles: ["./test/setupDom.ts"] },
      },
    ],
  },
});
