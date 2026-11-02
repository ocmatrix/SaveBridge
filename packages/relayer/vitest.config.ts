import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/helpers/globalSetup.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/main.ts"],
      reporter: ["text-summary", "text"],
    },
  },
});
