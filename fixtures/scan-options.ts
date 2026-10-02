/** Synthetic scan-option fixtures shared by the live tests (redact-secret-adapters#175). Nothing here is a credential. */

/** A declarative ruleset (`docs/guides/rulesets.md` in the core) for a made-up in-house token format. */
export const SYNTHETIC_RULESET = [
  "ruleset-revision: 1",
  "detector: synthetic-example-token",
  "specificity: contextual",
  'prefix: "SYNTH_"',
  "alphabet: alnum-dash",
  "run: at-least 20",
  "validator: none",
  "",
].join("\n");

/** A token that format matches. It carries Medium confidence, so the core's default policy only warns on it. */
export const SYNTHETIC_TOKEN = "SYNTH_EXAMPLE-TOKEN-000000000001";

/** A ruleset the core must refuse. Its text must never reach an error. */
export const BROKEN_RULESET = "ruleset-revision: 1\nSYNTHETIC-BROKEN-RULESET-MARKER\n";
