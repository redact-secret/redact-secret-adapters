/**
 * Coexistence with `@redact-secret/vault`
 * (redact-secret/redact-secret-adapters#52), on the **real installed core**
 * through the live factory.
 *
 * This boundary and the vault's `capture()` occupy the same seam — the path to
 * the model — so this is the package where a rewrite would hurt most. The
 * documented composition order is **capture first, adapters after**: the vault
 * replaces a detected secret with a `<rsv_…>` token, and what then reaches
 * `sanitizeText` / `sanitizeValue` / `buildContext` / `openStream` is already
 * tokenized text. If this boundary rewrote a token to `<GENERIC_TOKEN_1>` the
 * application's `restore()` would answer `RESTORE_DENIED` and the value would
 * be gone, with no error raised anywhere near here.
 *
 * `@redact-secret/vault` ships from the sibling `redact-secret-vault`
 * repository and is **not** a dependency of this one. Only the shape of its
 * token is reproduced, from the shared fixture, and asserted to survive.
 *
 * The last block is the placeholder side of the same contract: the vault
 * refuses any input that already holds the literal `rsv_`
 * (`TOKEN_LITERAL_IN_INPUT`), so no default this repository ships may emit
 * one. `placeholderFormatter` is a supported option here, which is exactly why
 * "the default never produces `rsv_`" has to be a test rather than an
 * assumption.
 */

import { expect, test } from "vitest";

import { VAULT_TOKEN, VAULT_TOKEN_CONTEXTS, VAULT_TOKEN_LITERAL } from "../../../fixtures/vault-token.js";
import {
  AI_CONTEXT_DEFAULT_LIMITS,
  type AiContextOutcome,
  createAiContextBoundary,
  withDefaultLimits,
} from "../src/index.js";

const SYNTHETIC_TOKEN = `ghp_${"SYNTHETICREVOKED"}${"0".repeat(20)}`;

function okValue(outcome: AiContextOutcome<unknown>): unknown {
  if (outcome.outcome !== "ok") throw new Error(`expected ok, got ${outcome.outcome}`);
  return outcome.value;
}

test("every adversarial context survives sanitizeText byte for byte, with no findings", async () => {
  const boundary = await createAiContextBoundary();
  for (const { name, text } of VAULT_TOKEN_CONTEXTS) {
    const outcome = boundary.sanitizeText(text, { boundary: "user-input" });
    expect(outcome, name).toEqual({ outcome: "ok", value: text, findings: [] });
  }
});

test("a token under an api_key key survives the key-aware second scan", async () => {
  // `sanitizeValue` rescans a leaf inside `{"<key>":"<leaf>"}` when the leaf
  // alone reports nothing, which is precisely the view in which a token most
  // resembles the credential it replaced.
  const boundary = await createAiContextBoundary();
  const value = {
    api_key: VAULT_TOKEN,
    authorization: `Bearer ${VAULT_TOKEN}`,
    nested: { args: [`Client(api_key="${VAULT_TOKEN}")`, `export OPENAI_API_KEY=${VAULT_TOKEN}`] },
  };
  expect(okValue(boundary.sanitizeValue(value, { boundary: "tool-result" }))).toEqual(value);
});

test("a token survives a built context and a tool result", async () => {
  const boundary = await createAiContextBoundary();
  const built = boundary.buildContext([
    { role: "user", boundary: "user-input", text: `Client(api_key="${VAULT_TOKEN}")` },
    { role: "tool", boundary: "tool-result", value: { api_key: VAULT_TOKEN } },
  ]);
  expect(okValue(built)).toEqual([
    { role: "user", content: `Client(api_key="${VAULT_TOKEN}")` },
    { role: "tool", content: { api_key: VAULT_TOKEN } },
  ]);
  expect(okValue(boundary.sanitizeToolResult(`Authorization: Bearer ${VAULT_TOKEN}\n`))).toBe(
    `Authorization: Bearer ${VAULT_TOKEN}\n`,
  );
});

test("a token split across stream chunks is reassembled byte for byte", async () => {
  const boundary = await createAiContextBoundary();
  const text = `Client(api_key="${VAULT_TOKEN}")`;
  for (let split = 0; split <= text.length; split += 1) {
    const stream = boundary.openStream({ boundary: "tool-result" });
    stream.append(text.slice(0, split));
    stream.append(text.slice(split));
    expect(stream.finalize(), `split at ${split}`).toEqual({ outcome: "ok", value: text, findings: [] });
  }
});

test("this package ships no default placeholderFormatter", async () => {
  const resolved = withDefaultLimits({}) as unknown as Record<string, unknown>;
  expect("placeholderFormatter" in resolved).toBe(false);
  expect(Object.keys(AI_CONTEXT_DEFAULT_LIMITS).sort()).toEqual([
    "incrementalLimits",
    "traversalLimits",
    "wholeInputLimits",
  ]);
});

test("the placeholder the defaults actually produce never contains the literal the vault refuses", async () => {
  const boundary = await createAiContextBoundary();
  const redacted = okValue(boundary.sanitizeText(`deploy with API_KEY=${SYNTHETIC_TOKEN}`)) as string;
  expect(redacted).not.toContain(SYNTHETIC_TOKEN);
  expect(redacted).toMatch(/<[A-Z_]+_\d+>/);
  expect(redacted).not.toContain(VAULT_TOKEN_LITERAL);

  // The blocked and limited paths return no value at all, so there is no
  // placeholder to inspect — only the fixed outcome shape, which is checked
  // here for the same literal.
  const limited = boundary.sanitizeText("ordinary text\n".repeat(8192));
  expect(limited.outcome).toBe("blocked");
  expect(JSON.stringify(limited)).not.toContain(VAULT_TOKEN_LITERAL);
});
