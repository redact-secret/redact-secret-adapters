import { defineConfig } from "@playwright/test";

// One worker, one retry-free pass, short timeouts: the whole browser stage is bounded.
export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.mjs",
  workers: 1,
  retries: 0,
  timeout: 30000,
  expect: { timeout: 10000 },
  reporter: [["list"], ["json", { outputFile: "/out/playwright.json" }]],
  outputDir: "/tmp/playwright-artifacts",
  use: {
    baseURL: process.env.TESTBED_UI_URL ?? "http://ui:8080",
    // Chromium's sandbox needs privileges the container deliberately lacks (no SYS_ADMIN).
    // The browser only ever loads the testbed UI on the compose network.
    launchOptions: { args: ["--no-sandbox"] },
  },
});
