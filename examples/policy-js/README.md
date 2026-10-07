# Credentials, PII and policy: one input, three configurations (JavaScript)

PII detection is a separate switch from masking. This example runs the **same** synthetic
input under three configurations and shows what each one does, using `adapter-ai-context`
(which exposes findings and their actions) and `adapter-pino` (which exposes counters).

- Runtime: Node.js 22 or 24 (ESM).
- Installs: `@redact-secret/adapter-ai-context` 0.1.5, `@redact-secret/adapter-pino` 0.1.6, `@redact-secret/core` 0.1.0-beta.14, `pino` 10.3.1.
- Needs no network service and no credentials.

## Run it

Copy this folder out of the repository first (see [how](../README.md#run-one)), then:

```sh
npm install
npm start
```

## The three configurations

PII activation is process-wide and one-shot, so each configuration runs in its **own
process**. Do not try to switch between them inside one initialized process.

<!-- snippet: examples/policy-js/index.mjs#configurations -->
```js
// An explicit core policy. It replaces the built-in one for EVERY finding, so keep `block` for the
// type the built-in policy blocks. This is an example choice, not a recommendation.
const explicitPolicy = {
  evaluate: (finding) => (finding.type === "private_key" ? "block" : "redact"),
};

const CONFIGURATIONS = {
  default: {}, // credentials only: PII stays off
  pii: { pii: ["pii:global"] }, // PII activated, the core's default policy
  policy: { pii: ["pii:global"], policy: explicitPolicy }, // PII activated, your policy
};
```

The input is one bundled synthetic sample holding a credential, an email address and a
`password=` value. Each profile reads it through the public APIs:

<!-- snippet: examples/policy-js/index.mjs#ai-context -->
```js
const boundary = await createAiContextBoundary(options);
const result = boundary.sanitizeText(SAMPLE, { boundary: "user-input" });
// result.outcome === "ok": result.value is safe to use and result.findings says what the core decided.
// `changed` is false when the value equals the input, even though findings were reported (a warn).
```

<!-- snippet: examples/policy-js/index.mjs#pino -->
```js
let counts;
let line = "";
const hooks = await createRedactingHooks({
  ...options,
  onOutcome: (outcome) => {
    counts = outcome.values;
  },
});
const logger = pino(
  { base: null, timestamp: false, hooks },
  {
    write(text) {
      line += text;
    },
  },
);
logger.info(SAMPLE);
// counts: scanned, findings, redacted, blocked, limited, failed. No values, no finding details.
```

## Expected output

<!-- expected-output -->
```text
== default ==
ai-context  changed=true  findings: github_token/high/redact, contextual_secret/medium/warn
            token <SECRET_1>; customer email: jane.doe@acme-corp.io; password=hunter2hunter2
warn-only   changed=false  findings: contextual_secret/medium/warn
pino        findings=3 redacted=1 blocked=0 failed=0
            {"level":30,"msg":"token <SECRET_1>; customer email: jane.doe@acme-corp.io; password=hunter2hunter2"}
== pii ==
ai-context  changed=true  findings: github_token/high/redact, pii_global_email/high/redact, contextual_secret/medium/warn
            token <SECRET_1>; customer email: <SECRET_2>; password=hunter2hunter2
warn-only   changed=false  findings: contextual_secret/medium/warn
pino        findings=4 redacted=1 blocked=0 failed=0
            {"level":30,"msg":"token <SECRET_1>; customer email: <SECRET_2>; password=hunter2hunter2"}
== policy ==
ai-context  changed=true  findings: github_token/high/redact, pii_global_email/high/redact, contextual_secret/medium/redact
            token <SECRET_1>; customer email: <SECRET_2>; password=<SECRET_3>
warn-only   changed=true  findings: contextual_secret/medium/redact
pino        findings=3 redacted=1 blocked=0 failed=0
            {"level":30,"msg":"token <SECRET_1>; customer email: <SECRET_2>; password=<SECRET_3>"}
OK: the three configurations differ as documented
```

The `OK:` line means every difference below was asserted. A `FAIL:` line names the
configuration that did not behave as documented and exits 1.

## What each row shows

| Configuration | Credential | Email (PII, high confidence) | `password=` (a `warn`) |
| --- | --- | --- | --- |
| `default` | redacted | untouched: PII is off, so there is no finding for it | untouched: the finding is reported with action `warn` |
| `pii` | redacted | redacted | untouched: still `warn` |
| `policy` | redacted | redacted | redacted: your policy turned `warn` into `redact` |

- **`redact`** replaces the matched part with a placeholder and the rest of the value is kept.
- **`warn`** reports a finding and leaves the text alone. An `ok` result whose value equals its
  input can therefore still carry findings. In `adapter-ai-context` and `adapter-mcp` compare the
  value with the input; in logging and tracing, look for `findings` above `redacted` in the counters.
- **`block`** refuses the whole value: `blocked` in AI-context and MCP, `[REDACTED:BLOCKED]` in
  logs and spans. The built-in policy blocks a private key; the example policy keeps that.
- Turning PII on does not make every PII type masked. The `password=` row is a credential-shaped
  `warn`, because the core's default policy gates by confidence: only high confidence is redacted.
  In the core version pinned here no PII sample the examples tried resolved to `warn`
  (an email, an IBAN or a payment card with a context word redacted at high confidence; a bare
  one or a phone number was not detected at all), so the warn row uses a credential-shaped value.
  Whether a given PII value is detected, and at which confidence, is decided by the core and can
  change with its version. A masked example here does not establish that every PII type is supported.
- **Counts are not secrets.** `findings` counts findings reported by every scan pass, and
  `adapter-pino` scans the record in two hooks, so it is larger than the number of distinct
  secrets (`default` reports 3 for 2 findings, and `redacted=1` counts the one log value that changed).
  They are for metrics. They are not a detection guarantee either: an `ok` result with no findings
  means the core reported none, not that the input held no secret.

The policy shown replaces the built-in policy for every finding. It is an example of what a
policy is, not a recommendation: this repository decides no policy. Only the public `policy`
option is used, with finding metadata the core passes in (type, confidence), never a score or a value.

## Options this example does not use

`scanLimits`, `ruleset`, `placeholderFormatter` and the declarative `actionPolicy` are accepted by the adapters
pinned here (`actionPolicy` needs core `0.1.0-beta.14`, which is pinned), but this example does not use them.
[Policy overlays and what is tested](../../docs/policy-overlays.md) shows `actionPolicy` and the callback policy side by side.

## Next

[Policy overlays and what is tested](../../docs/policy-overlays.md) · [PII guide](../../docs/pii.md) · [Python version of this comparison](../policy-python) · [counters](../../packages/adapter#outcome-counters)
