import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "scripts/test/**/*.test.mjs"],
    globalSetup: ["./vitest.global-setup.ts"],
    // `npm run coverage` (CI's Node 22 leg). The thresholds are the OpenSSF
    // Best Practices statement-coverage bar (80%), not the current level
    // (about 98% statements); a drop below either fails the run.
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**"],
      reporter: ["text-summary", "text"],
      thresholds: { statements: 80, lines: 80 },
    },
  },
});
