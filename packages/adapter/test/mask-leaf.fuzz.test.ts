import fc from "fast-check";
import { expect, test } from "vitest";

import { fakeScanAndRedact } from "../../../fixtures/fake-scanner.js";
import { maskLeafWith } from "../src/index.js";

// Unmistakably synthetic: the fake scanner's own magic token, never a real credential.
const SYNTHETIC_SECRET = "SECRET_TOKEN_7";

// Surrounding text that cannot itself contain a second scanner-recognised token.
const surrounding = fc.string({ maxLength: 200 }).filter((s) => !s.includes("SECRET_TOKEN_"));

test("maskLeafWith never throws on an arbitrary string and always returns a string", () => {
  fc.assert(
    fc.property(fc.string({ unit: "binary", maxLength: 500 }), (text) => {
      expect(typeof maskLeafWith(fakeScanAndRedact, text)).toBe("string");
    }),
  );
});

test("maskLeafWith never emits a planted synthetic secret, wherever it sits in the text", () => {
  fc.assert(
    fc.property(surrounding, surrounding, (before, after) => {
      const out = maskLeafWith(fakeScanAndRedact, `${before}${SYNTHETIC_SECRET}${after}`);
      expect(out).not.toContain(SYNTHETIC_SECRET);
    }),
  );
});
