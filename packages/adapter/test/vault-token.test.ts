/**
 * Coexistence with `@redact-secret/vault`
 * (redact-secret/redact-secret-adapters#52), on the **real installed core**
 * through the walk/mask path.
 *
 * The vault ships from the sibling `redact-secret-vault` repository and
 * is not a dependency here. It replaces a detected secret with a
 * `<rsv_…>` token on the way to a model and restores the original value
 * afterwards, so an adapter that rewrote a token to `<GENERIC_TOKEN_1>` would
 * not leak anything — it would destroy a value the application still needs,
 * and the application's `restore()` would answer `RESTORE_DENIED` with no
 * error anywhere near the adapter. Nothing else pins that, and the core has
 * widened `generic-token` in exactly this direction before (beta.10 began
 * redacting an SDK call argument), so it is pinned here: the shared fixture's
 * adversarial contexts must come back byte for byte.
 *
 * The second block pins the two paths where a token legitimately does **not**
 * survive. Both are the documented fail-closed behavior of `maskLeafWith` and
 * neither is a bug; they are asserted so that a reader finds them stated
 * rather than discovers them from a lost value. `python/tests/test_vault_token.py`
 * mirrors them.
 */

import { expect, test } from "vitest";

import { VAULT_TOKEN, VAULT_TOKEN_CONTEXTS, VAULT_TOKEN_LITERAL } from "../../../fixtures/vault-token.js";
import { createMaskSecrets, ERROR_MARKER, LIMIT_MARKER, maskLeafWith, type ScanAndRedact } from "../src/index.js";

test("every adversarial context survives the real core byte for byte", async () => {
  const maskSecrets = await createMaskSecrets();
  for (const { name, text } of VAULT_TOKEN_CONTEXTS) {
    expect(maskSecrets(text), name).toBe(text);
  }
});

test("a token survives every position the walker reaches", async () => {
  const maskSecrets = await createMaskSecrets();
  const data = {
    api_key: VAULT_TOKEN,
    content: [`Client(api_key="${VAULT_TOKEN}")`, { nested: { deep: VAULT_TOKEN } }],
    headers: { Authorization: `Bearer ${VAULT_TOKEN}` },
    count: 2,
  };

  const masked = maskSecrets(data);
  expect(JSON.stringify(masked)).toBe(JSON.stringify(data));
});

test("a token survives the Error branch of the walk", async () => {
  // An Error is rebuilt as `{ type, message, stack, ...ownProps }`, so this
  // asserts field by field rather than over the serialized whole.
  const maskSecrets = await createMaskSecrets();
  const error = Object.assign(new Error(`request failed: ${VAULT_TOKEN}`), {
    config: { headers: { Authorization: `Bearer ${VAULT_TOKEN}` } },
  });

  const masked = maskSecrets({ error }) as { error: { message: string; config: unknown } };
  expect(masked.error.message).toBe(`request failed: ${VAULT_TOKEN}`);
  expect(masked.error.config).toEqual({ headers: { Authorization: `Bearer ${VAULT_TOKEN}` } });
});

test("a token is not rewritten by a policy that blocks every finding, because there are no findings", async () => {
  // A `block` policy replaces the whole leaf, so a token that the core did
  // report on would become a marker. It does not report on one.
  const maskSecrets = await createMaskSecrets({ policy: { evaluate: () => "block" } });
  for (const { name, text } of VAULT_TOKEN_CONTEXTS) {
    expect(maskSecrets(text), name).toBe(text);
  }
});

test("no marker this package can emit contains the literal the vault refuses", async () => {
  // `@redact-secret/vault` rejects any input already holding `rsv_`
  // (TOKEN_LITERAL_IN_INPUT), so an adapter that produced one in its own
  // output would make the next capture unusable.
  expect(VAULT_TOKEN_LITERAL).toBe("rsv_");
  const maskSecrets = await createMaskSecrets();
  const leaky: ScanAndRedact = () => {
    throw new Error("simulated core failure");
  };
  const produced = [
    String(maskSecrets(`token ghp_${"x".repeat(36)} here`)),
    maskLeafWith(leaky, "anything"),
    maskLeafWith(leaky, "a".repeat(8), { maxStringLength: 4 }),
  ];
  for (const output of produced) expect(output).not.toContain(VAULT_TOKEN_LITERAL);
});

test("known boundary: a leaf past maxStringLength loses the token, and nothing can restore it", () => {
  const spy: ScanAndRedact = (text) => ({ text, findings: [] });
  const text = `Client(api_key="${VAULT_TOKEN}")`;
  expect(maskLeafWith(spy, text, { maxStringLength: text.length - 1 })).toBe(LIMIT_MARKER);
});

test("known boundary: a core failure loses the token, and nothing can restore it", () => {
  const leaky: ScanAndRedact = () => {
    throw new Error("simulated core failure");
  };
  expect(maskLeafWith(leaky, `Client(api_key="${VAULT_TOKEN}")`)).toBe(ERROR_MARKER);
});
