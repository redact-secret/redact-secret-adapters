/**
 * The two public entry points to the shared walker in `./walk.ts`. They are
 * the same walk: `maskSecretsWith` is shaped for masking callbacks
 * (`mask: ({ data }) => maskSecretsWith(scanAndRedact, data)` in Langfuse
 * JS), `maskLogValueWith` for logging hooks. Neither imports the core —
 * `scanAndRedact` is injected.
 */

import type { MaskOptions, ScanAndRedact } from "./types.js";
import { walkValue } from "./walk.js";

function assertScanner(caller: string, scanAndRedact: unknown): void {
  if (typeof scanAndRedact !== "function") {
    throw new TypeError(`${caller}: scanAndRedact must be a function`);
  }
}

/**
 * Masks every string reachable in `data`: plain objects, arrays, `Error`s
 * (as a redacted `{ type, message, stack, ...ownProps, cause }`), and any
 * other object as JSON would serialize it (its `toJSON()` result, else its
 * own enumerable properties). `scanAndRedact` is called once per leaf
 * string, so a `<SECRET_1>`-style placeholder index restarts at each leaf.
 */
export function maskSecretsWith(scanAndRedact: ScanAndRedact, data: unknown, options: MaskOptions = {}): unknown {
  assertScanner("maskSecretsWith", scanAndRedact);
  return walkValue(scanAndRedact, data, options);
}

/** The same walk as {@link maskSecretsWith}; kept as the logging-side name. */
export function maskLogValueWith(scanAndRedact: ScanAndRedact, data: unknown, options: MaskOptions = {}): unknown {
  assertScanner("maskLogValueWith", scanAndRedact);
  return walkValue(scanAndRedact, data, options);
}
