import { defineConfig } from "@playwright/test";

// One worker, no retries (a deterministic failure must stay a failure), short timeouts: the whole
// browser stage is bounded. Everything written goes under OUT (/out in the runner container, which
// is the run's reports directory): the JSON report always; the HTML report, traces and screenshots
// of failed tests are the artifacts CI uploads (#197). Journeys also save a few important-state
// screenshots there. Nothing is recorded that is not already on the page, which shows only
// scrubbed, bounded results of fixed synthetic scenarios.
const OUT = process.env.TESTBED_OUT ?? "/out";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.mjs",
  workers: 1,
  retries: 0,
  timeout: 30000,
  globalTimeout: 600000,
  expect: { timeout: 10000 },
  reporter: [
    ["list"],
    ["json", { outputFile: `${OUT}/playwright.json` }],
    ["html", { outputFolder: `${OUT}/playwright-report`, open: "never" }],
  ],
  outputDir: `${OUT}/playwright-artifacts`,
  use: {
    baseURL: process.env.TESTBED_UI_URL ?? "http://ui:8080",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    // Chromium's sandbox needs privileges the container deliberately lacks (no SYS_ADMIN).
    // The browser only ever loads the testbed UI on the compose network.
    launchOptions: { args: ["--no-sandbox"] },
  },
});
