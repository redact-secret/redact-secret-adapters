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

import { maskSecretsWith } from "./mask-secrets.js";
import type { MaskOptions } from "./types.js";

/**
 * Awaits `initialize()` once, then returns `maskSecrets(data)`. `await
 * initialize()` must resolve before the core's `scanAndRedact` is used;
 * this factory enforces that order so a caller can't forget it.
 */
export async function createMaskSecrets(options: MaskOptions = {}): Promise<(data: unknown) => unknown> {
  const { initialize, scanAndRedact } = await import("@redact-secret/core");
  await initialize();
  return (data) => maskSecretsWith(scanAndRedact, data, options);
}
