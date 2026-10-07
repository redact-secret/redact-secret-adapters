# Policy overlays and configuration isolation: what is tested, what is not

A consumer recipe for choosing how findings are handled: the core's default
policy, a declarative one-rule override that falls back to the default, and a
full callback replacement. It extends the [policy comparison](../examples/policy-js)
(#184) and the [action truth table](./action-semantics.md) (#214); it adds no API
and no policy. Every value is synthetic. The core decides what is detected;
these checks pin what each adapter does with the core's answer.

## The overlays

| Overlay | Option | Unmatched findings |
| --- | --- | --- |
| `default` | none | the core's built-in policy: most credentials `redact`, a private key `block`, medium-confidence assignments `warn` |
| `rule-token-warn` | `actionPolicy`: one rule, `github_token` -> `warn` | keep the **default** action (the private key is still blocked) |
| `rule-password-redact` | `actionPolicy`: one rule, `contextual_secret` -> `redact` | keep the **default** action |
| `callback-redact-all` | `policy: { evaluate: () => "redact" }` | none: the callback **replaces** the default for every finding |
| `callback-token-only` | `policy` that only handles `github_token` and returns `allow` otherwise | none: it allows what the default would block |

Declarative `actionPolicy` needs core `0.1.0-beta.14` or later and an adapter
release that has it: `@redact-secret/adapter` 0.1.9, `adapter-pino` 0.1.6,
`adapter-otel-trace` 0.1.4, `adapter-otel-logs` 0.1.0-beta.4,
`adapter-ai-context` 0.1.5, `adapter-mcp` 0.1.6 and `redact-secret-adapters`
0.1.6 (PyPI). The evidence record below is revision-bound: it was run on a
workspace build before those releases, not on the published tarballs. A callback
`policy` works on every supported core.
`actionPolicy` and `policy` together are rejected before anything is scanned
(`policy and actionPolicy are mutually exclusive`).

**The trap.** A callback replaces the default for every finding. `callback-token-only`
releases a private key as written (`private_key/high/allow`) and
`callback-redact-all` turns the default block into a redaction. Use a callback
only when you mean to own every action; use a one-rule `actionPolicy` to change one
and keep the rest.

## What each host emits (PII off, then on)

Input records: a token (`github_token`, high), `password=...` (`contextual_secret`,
**medium**, an emitted lower-confidence finding), a private key, a
`customer email:` line (PII), and a benign control (`build ok at 12:00, version 1.2.3`)
that is unchanged with no finding under every overlay.

| Overlay | Token | `password=` | Private key | Email, PII off | Email, PII on |
| --- | --- | --- | --- | --- | --- |
| `default` | redacted | **warn: released**, finding reported | **blocked** | released, no finding | redacted |
| `rule-token-warn` | **warn: released** | warn: released | **blocked** | released, no finding | redacted |
| `rule-password-redact` | redacted | redacted | **blocked** | released, no finding | redacted |
| `callback-redact-all` | redacted | redacted | **redacted** (default block lost) | released, no finding | redacted |
| `callback-token-only` | redacted | **allow: released** | **allow: released** | released, no finding | **allow: released** |

Each cell is an exact assertion on the host's real output, and each AI-context
value is also compared with the core's own text for the same overlay:

| Host | Test | Exact expectations |
| --- | --- | --- |
| AI-context (`sanitizeText`) | `packages/adapter-ai-context/test/policy-overlays-live.test.ts` (PII off), `policy-overlays-pii-live.test.ts` (PII on) | outcome, value and every `type/confidence/action` triple, for 5 overlays x 5 inputs, twice |
| Logs (pino) | `packages/adapter-pino/test/policy-overlays-live.test.ts` | the exact JSON line written by a real logger and the `redacted`/`blocked`/`failed`/`limited` counters, PII off |
| MCP (`sanitizeToolResult`) | `packages/adapter-mcp/test/policy-overlays-live.test.ts` | outcome, the exact wire result (the fixed `isError` result for a block) and finding actions, PII off |

### Warn-only observation versus rejection versus redaction

| Host | Warn-only (observation) | Redaction | Rejection (`block`) |
| --- | --- | --- | --- |
| Logs and traces | the text is **released**; `findings` rises while `redacted` and `blocked` stay 0 | placeholder in place, `redacted` +1 | `[REDACTED:BLOCKED]` for the whole string, `blocked` +1 |
| AI-context | `ok`, value equals the input, `findings` carries `action: "warn"` (and `onFinding` fires) | `ok` with placeholders | `blocked` / `policy`, no value, no findings |
| MCP | `ok`, the result still carries the text | `ok` with placeholders | `blocked` / `policy`; the wire result is the fixed `isError` message with nothing of the input |

Do not ship a path you configured with `warn` or `allow`: the credential is still
in its output. OpenTelemetry traces use the same rules as logs; the overlay matrix
above was **not** repeated for them (the single-action table in
[action-semantics.md](./action-semantics.md) covers them).

## Whole input versus incremental

`openStream()` (`append`, `finalize`, `abort`) gives the same answer as
`sanitizeText` for the same text under every overlay, for chunk sizes 1, 2, 7, 64
and the whole input (outcome, value and findings; a `blocked` stream equals the
whole-input `blocked`). Tested invariants: nothing is released before
`finalize`; `accepting` is false after `finalize` or `abort`; an aborted stream
finalizes to `aborted`.

Option differences, not a behavior difference: the whole-input path is bounded by
`wholeInputLimits` (`maxInputBytes`, `maxFindings`) and `traversalLimits`; the
incremental path by `incrementalLimits` (`maxInputCodeUnits`,
`maxBufferedCodeUnits`, `maxTokenCodeUnits`, `maxMultilineCodeUnits`). A limit is
a fixed `blocked` outcome, never a partial release.

## Configuration order, conflicts and isolation

- **Conflicts are explicit.** `policy` with `actionPolicy`, and any loose scan
  option beside an injected `scanConfig`, throw a fixed, input-free `TypeError`
  before the core is loaded. There is no precedence rule. Asserted in the
  AI-context file above, and by `packages/*/test/injected-scan-config-live.test.ts`
  and `packages/adapter/test/action-policy-live.test.ts`.
- **PII is process-wide and one-shot**, which is why the PII-on cases are a
  separate test file (its own process). Turning PII on in one factory turns it on
  for the process.
- **Independent per-handle configuration is unsupported, and not tested.**
  The published core exports no configuration-bound scanner handle: core #1222
  deferred it, and the adapters do not wrap the one process-wide core to pretend
  to. So two adapters in one process do **not** have isolated PII or policy state
  that this repository can claim, there is no cross-talk test to run, and a
  singleton wrapper must not be called isolated. Each factory's `actionPolicy` or
  `policy` is its own (a snapshot per factory), but PII activation is shared.
  Revisit when the core ships a handle.

## What is not covered

- The released adapter packages support `actionPolicy`, but the overlay tests
  here ran on a workspace build, not on the published tarballs, so no
  published-adapter evidence exists for these overlays; CI does run the new files
  at the declared core endpoints (see `qualifiedBy` in `compatibility.json`).
- Python: this change adds no Python recipe test; Python `action_policy` has its own
  tests from #217.
- Docker testbed (`npm run testbed`): **not extended and not run** for this change. The overlay evidence is vitest against the real core in this checkout, not a clean-install consumer run, so it is revision-bound candidate evidence only. A clean-install overlay scenario (and a published-adapter one) is deferred; until then nothing here claims clean-install, Docker or browser coverage of the overlays.
- Detection quality (what is a secret or PII, at which confidence) is the core's.
  An empty-input construction probe is **not** evidence that a callback or action
  works; none of the checks above relies on one.

## Evidence record

| Field | Value |
| --- | --- |
| Source | `redact-secret/redact-secret-adapters` `develop` at `378b148` plus this change (PR for #215) |
| Artifact under test | workspace build of this checkout (`npm run build`), not a published tarball |
| Core | `@redact-secret/core` `0.1.0-beta.14`, lockfile integrity `sha512-1h5NxUto2ZEqQD5hfIgbzwDZkmu6WXdlmtF0waG3FcKDhpCEoUphgj4B4VGRyhVhjJOFT58/TrER+3EL1bCnag==`; native addon `@redact-secret/node-darwin-x64` `0.1.0-beta.14` |
| Hosts | pino `10.3.1`, `@modelcontextprotocol/sdk` `1.32.1`; the supported ranges are in [compatibility.md](./compatibility.md) |
| Runtime | Node `v22.23.1`, macOS (darwin x64) |
| Command | `npx vitest run packages/adapter-ai-context/test/policy-overlays packages/adapter-pino/test/policy-overlays packages/adapter-mcp/test/policy-overlays`, then `npm run build && npm run typecheck && npm test && npm run compat:check` |
| Outcome | local run 2026-10-07: build, typecheck, `compat:check` and `examples:check` clean; `npm test` 118 files, 1429 passed, 7 skipped (the 15 new tests ran and passed: 7 AI-context, 7 pino, 1 MCP). The new files are listed under `qualifiedBy` in `compatibility.json`, so CI also runs them at the declared core endpoints (they are skipped below the `actionPolicy` floor) |
