/**
 * The shared vault-token fixture, read from `vault-token-cases.json`
 * (redact-secret/redact-secret-adapters#52). Kept in sync by hand with
 * `python/tests/vault_token.py`; both build the same token and the same
 * context strings from the same file, so a case means the same thing in
 * either language.
 *
 * `@redact-secret/vault` lives in the sibling `redact-secret-vault`
 * repository and is **not** a dependency of this one. Only the shape of its
 * token is reproduced here — a `<rsv_` prefix, 32 hex digits, a `>` — because
 * that shape is its published contract and an adapter that rewrote one would
 * silently destroy a value the application still needs. The token is
 * assembled from its parts at load time, the way every other synthetic value
 * in this repository is: it is a placeholder shape, never a credential.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface VaultTokenFixture {
  readonly token: { readonly prefix: string; readonly body: string; readonly suffix: string };
  readonly contexts: readonly { readonly name: string; readonly before: string; readonly after: string }[];
}

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./vault-token-cases.json", import.meta.url)), "utf-8"),
) as VaultTokenFixture;

/** One vault-shaped token: `<rsv_` + 32 hex digits + `>`. */
export const VAULT_TOKEN = `${fixture.token.prefix}${fixture.token.body}${fixture.token.suffix}`;

/** The literal the vault refuses to accept in its own input (`TOKEN_LITERAL_IN_INPUT`). */
export const VAULT_TOKEN_LITERAL = fixture.token.prefix.slice(1);

/** One adversarial placement of {@link VAULT_TOKEN}, with the text to feed an adapter. */
export interface VaultTokenContext {
  readonly name: string;
  readonly text: string;
}

/**
 * Every context in the fixture, as ready-to-scan text. A context is a place a
 * token is most likely to be mistaken for the credential it replaced: an SDK
 * call argument, an `Authorization: Bearer` header, an environment assignment,
 * a JSON value under an `api_key` key, plain prose, and the bare token.
 */
export const VAULT_TOKEN_CONTEXTS: readonly VaultTokenContext[] = fixture.contexts.map((context) => ({
  name: context.name,
  text: `${context.before}${VAULT_TOKEN}${context.after}`,
}));
