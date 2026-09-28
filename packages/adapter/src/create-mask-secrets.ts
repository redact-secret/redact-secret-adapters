/**
 * The live wrapper: the only module in this package that touches
 * `@redact-secret/core` at runtime, and only when `createMaskSecrets` is
 * called. The core is loaded with a dynamic `import()` so everything else
 * this package exports stays usable with an injected scanner and no core
 * installed.
 *
 * Langfuse JS's `mask` option receives `{ data }` and must return the
 * masked value (https://langfuse.com/docs/observability/features/masking):
 *
 * ```js
 * import { Langfuse } from "langfuse";
 * import { createMaskSecrets } from "@redact-secret/adapter";
 *
 * const maskSecrets = await createMaskSecrets();
 * const langfuse = new Langfuse({ mask: ({ data }) => maskSecrets(data) });
 * ```
 *
 * `maskSecrets` also accepts a parsed object/array directly (not only a
 * string), so the same function works for the generic "mask this payload
 * before tracing" case, not only Langfuse's form.
 */

import { activateCore } from "./activation.js";
import { maskSecretsWith } from "./mask-secrets.js";
import type { CoreActivation, MaskOptions } from "./types.js";

/** {@link MaskOptions} plus the live factory's PII activation. */
export type CreateMaskSecretsOptions = MaskOptions & CoreActivation;

/**
 * Reads `pii` by property rather than by rest-destructuring, the way the host
 * packages' live factories do: a property read follows the prototype chain,
 * so an options object layered over a shared base keeps its activation, and
 * the rest of `options` reaches `maskSecretsWith` as the same object with its
 * inherited `policy`, `limits` and `counter` intact.
 */
function activationOf(options: CoreActivation): CoreActivation {
  return options.pii === undefined ? {} : { pii: options.pii };
}

/**
 * Runs the one core-activation step, then returns `maskSecrets(data)`.
 * Activation must resolve before the core's `scanAndRedact` is used; this
 * factory enforces that order so a caller can't forget it.
 *
 * Activation is shared with every other live factory
 * (`activateCore`): omitting `pii` asserts no selection and tolerates an
 * application that already activated its own, while passing `pii` selects
 * and then verifies it. Before that was true here, this factory's bare
 * `initialize()` made `@redact-secret/adapter`'s own documented Langfuse
 * path the one entry point that still broke under application-first PII
 * activation (#57).
 */
export async function createMaskSecrets(options: CreateMaskSecretsOptions = {}): Promise<(data: unknown) => unknown> {
  const loaded = await import("@redact-secret/core");
  await activateCore(loaded, activationOf(options));
  return (data) => maskSecretsWith(loaded.scanAndRedact, data, options);
}
