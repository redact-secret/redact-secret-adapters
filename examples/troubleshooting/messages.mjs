// snippet:start messages
// Fixed labels only. Nothing from the input, the error, a path or a key ever reaches these strings,
// and an outcome this table does not know falls back to the generic entry.
const FIXED = {
  ok: ["Sanitized value available.", ""],
  "blocked/policy": ["Blocked by redaction policy.", "We could not process this request."],
  "blocked/limit_exceeded": ["Input is over a configured limit.", "This request is too large to process safely."],
  "blocked/unsupported_value": ["Input held a value that is not JSON-shaped.", "We could not process this request."],
  "blocked/lifecycle": ["A stream was reused or misused.", "Something went wrong. Please try again."],
  "blocked/core_error": [
    "The redaction core failed, is not initialized, or rejected an option.",
    "Something went wrong. Please try again.",
  ],
  aborted: ["The operation was cancelled.", "The request was cancelled."],
};
const GENERIC = ["Unrecognised outcome; treated as blocked.", "We could not process this request."];

/** `internal` is for your logs and metrics (a trusted reader). `user` is safe to show to anyone. */
export function describeOutcome(outcome) {
  const key = outcome.outcome === "blocked" ? `blocked/${outcome.reason}` : outcome.outcome;
  const [internal, user] = Object.hasOwn(FIXED, key) ? FIXED[key] : GENERIC;
  // `code` is a fixed label from the core's registry, but only an allowlisted shape is forwarded.
  const code = typeof outcome.code === "string" && /^[A-Z_]{1,40}$/.test(outcome.code) ? ` (${outcome.code})` : "";
  return { internal: `${internal}${code}`, user };
}
// snippet:end messages
