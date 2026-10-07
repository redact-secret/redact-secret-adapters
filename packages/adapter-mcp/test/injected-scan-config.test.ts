/**
 * An injected `scanConfig` is an unsupported surface of the MCP boundary, as of
 * the AI-context boundary it is built on (redact-secret-adapters#213): named
 * and rejected with a fixed message, never ignored.
 */

import { resolveScanConfig } from "@redact-secret/adapter";
import { expect, test } from "vitest";

import { createMcpBoundary } from "../src/index.js";

test("createMcpBoundary rejects an injected scanConfig by name", async () => {
  const scanConfig = resolveScanConfig({});
  await expect(createMcpBoundary({ scanConfig } as never)).rejects.toThrow(
    "scanConfig is not supported by the AI-context boundary",
  );
});
