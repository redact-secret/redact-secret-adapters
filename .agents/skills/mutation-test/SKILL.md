---
name: mutation-test
description: Measure whether the adapters' tests catch fail-closed regressions by mutating the security-critical source with Stryker and reporting surviving mutants. Use when asked to check test strength, after changing masking or boundary code, or for "mutation-test", "/mutation-test packages/adapter/src/walk.ts". Report-only; proposes tests for survivors.
---

# mutation-test

A fail-closed check that can be deleted without a test failing is not protected. Find those.

## Setup

- Use `@stryker-mutator/core` with `@stryker-mutator/vitest-runner` and the TypeScript checker, as exact-pinned devDependencies, matching the repo's exact-pinning of `@biomejs/biome` and `fast-check`. Put config in `stryker.config.json`. Ask before committing new files, and keep `.stryker-tmp/` and `reports/` out of git.
- The test runner is Vitest. `vitest.global-setup.ts` builds every package first, so point Stryker's `vitest.configFile` at `vitest.config.ts` and mutate one package at a time to keep runs short. Set `vitest.related: true` if supported.
- Mutate only security-relevant source, or the file given as an argument:
  - `packages/adapter/src/`: `mask-leaf.ts`, `walk.ts`, `walk-strict.ts`, `outcome.ts`, `activation.ts`
  - `packages/adapter-pino/src/`: `hooks.ts`, `log-method.ts`, `stream-write.ts`, `format-message.ts`
  - `packages/adapter-otel/src/span-processor.ts`
  - `packages/adapter-ai-context/src/boundary.ts`
  - `packages/adapter-mcp/src/boundary.ts`
- Python: `python/redact_secret_adapters/` (`mask_leaf.py`, `_walk.py`, `logging_filter.py`, `otel.py`) can be mutated with `mutmut` against `pytest python/tests`. Do this only when asked, and say it separately.

## Run

`npx stryker run --concurrency 4`. Record Stryker's version and the mutation score.

## Triage survivors

For each surviving mutant, decide one of the following:
- **Gap.** It weakens a security check: a fail-closed marker or its trigger, a `block` whole-leaf replacement, a `DEFAULT_LIMITS` comparison (`<` versus `<=`), the cycle check, a `walkStrict` early failure, staged-stream release, the `accepting` check, the read-back after an OpenTelemetry write, the `SAFE_FINDING_FIELDS` allow-list, or error sanitization. Propose the exact test that kills it, at the boundary value.
- **Equivalent.** The behavior is unchanged. Say why in one line.
- **Non-security.** A message string, a comment, a type-only branch, or dead code. List it without action.

## Output

| Verdict | file:line | Mutator | Mutation | Why it survived | Proposed test |
| --- | --- | --- | --- | --- | --- |

End with the mutation score overall and for security-relevant lines, and the number of gaps.

## Rules

- Never commit mutated source. Confirm `git diff packages/*/src python/redact_secret_adapters` is empty when done.
- Synthetic values only in any proposed test: `SECRET_TOKEN_7` and the fake scanner in `fixtures/`.
- Put a proposed case in a shared `fixtures/*.json` file when the behavior exists in both languages, so both suites cover it.
