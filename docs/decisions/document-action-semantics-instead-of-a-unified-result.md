---
decision_id: decision-document-action-semantics-instead-of-a-unified-result
status: accepted
scope: adapters
title: Document policy action semantics per boundary instead of adding a unified result
decided_at: 2026-10-06
issue: redact-secret/redact-secret-adapters#214
---
# Document policy action semantics per boundary instead of adding a unified result

Part of redact-secret/redact-secret#1216 (user-owned configuration), adapters
side. #214 asked whether a narrow convenience API or documentation is enough
for direct callers to predict what `allow`, `warn`, `redact` and `block` do at
each boundary.

## Decision

Documentation is sufficient. Nothing is added to a public API and no existing
output changes.

- The truth table lives in [docs/action-semantics.md](../action-semantics.md)
  and is asserted by an executable test per host package, over the real core,
  with exact host output.
- **No generic result type.** Logging and tracing keep their documented
  whole-leaf block markers and counters; AI-context and MCP keep `ok` /
  `blocked` / `aborted` (and MCP's `tool_error` / `read_error`) with no value on
  a non-`ok` outcome. They are not unified into one shape.
- **No breaking change, and no new option.** The legacy callback `policy`
  stays the only policy surface; this decision touches no marker, outcome,
  reason, code or counter.

## Why documentation is enough

- The two families differ for a reason the table states, not by accident. A log
  line with one masked field is still useful and safe; a model context that is
  partly masked is not. A unified result would have to pick one of those, and the
  fixed markers and outcomes are public API that move only in a major version
  ([fail-closed rules](../../ARCHITECTURE.md#fail-closed-rules)).
- A direct caller who needs one answer ("did anything remain that I must
  handle?") already has it: the AI-context and MCP `findings`, and the counters
  in logging and tracing, report it in every boundary, and the table says how to
  read it. A wrapper that returns `{ released, leftFindings }` over those would
  add a third shape beside the two it would summarize, which every adapter and
  every test would then have to keep in step with the core.
- The risk the issue names is `allow` and `warn` being read as protection. That
  is a documentation problem, and the table puts it first.
- A convenience type would also have to be defined before the core's declarative
  overlay exists, and would encode today's callback surface into a new public
  contract.

## Consequences

- Revisit if a core release ships the declarative overlay and a real caller shows
  the table plus `findings` is not enough, with a concrete result shape. That
  would be a new, additive API with its own decision, never a replacement for a
  boundary's outcome.
- The declarative overlay is **planned** and tied to a future core release. No
  package here reads, passes or claims it.

## Evidence

- `packages/*/test/action-semantics-live.test.ts` and
  `fixtures/action-semantics.ts`, run on `@redact-secret/core`
  `0.1.0-beta.13`.

## Status update (2026-10-07)

The decision stands. "The declarative overlay is **planned**" is superseded:
core `0.1.0-beta.14` accepts a declarative `actionPolicy`, and the adapters pass
it through unchanged in their 2026-10-07 releases (redact-secret-adapters#217).
It changes which action a finding gets, not what a boundary does with it, so the
tables in [action-semantics.md](../action-semantics.md) apply to it as written.
See [policy-overlays.md](../policy-overlays.md).
