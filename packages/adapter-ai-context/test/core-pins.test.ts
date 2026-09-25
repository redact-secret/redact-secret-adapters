/**
 * The vendored core contract files are exactly the bytes recorded in
 * `fixtures/core/pins.json`, pinned to a 40-hex core commit. Moving the pin
 * means copying the file from the new commit and updating both fields.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { expect, test } from "vitest";

const root = new URL("../../../", import.meta.url);
const pins = JSON.parse(readFileSync(new URL("fixtures/core/pins.json", root), "utf-8")) as {
  files: { path: string; repository: string; commit: string; sourcePath: string; sha256: string }[];
};

test.each(pins.files.map((pin) => [pin.path, pin] as const))("%s matches its pinned digest", (_path, pin) => {
  expect(pin.repository).toBe("redact-secret/redact-secret");
  expect(pin.commit).toMatch(/^[0-9a-f]{40}$/);
  const digest = createHash("sha256")
    .update(readFileSync(new URL(pin.path, root)))
    .digest("hex");
  expect(digest).toBe(pin.sha256);
});
