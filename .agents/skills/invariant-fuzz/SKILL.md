---
name: invariant-fuzz
description: Property-based fuzzing of the adapters' fail-closed invariants with fast-check against the built packages. Generates random strings, value trees, and hostile scanners and reports any counterexample with its seed. Use when asked to fuzz the adapters or check their invariants ("invariant-fuzz", "/invariant-fuzz 20000", "fuzz walk").
---

# invariant-fuzz

Break the adapters' invariants with generated inputs. Report counterexamples, not opinions.

## Setup

- `fast-check` is already an exact-pinned root devDependency (`4.10.2`). Do not add another property library.
- Build first: `npm run build`. Properties run under Vitest, and `vitest.global-setup.ts` builds every package before the suite.
- Properties live beside the existing ones as `packages/<name>/test/*.fuzz.test.ts` (see `packages/adapter/test/mask-leaf.fuzz.test.ts`). Add to that file or a sibling per package. Ask before committing new files.
- Use the injected-scanner factories (`maskLeafWith`, `maskSecretsWith`, `createAiContextBoundaryWith`, and so on) with `fixtures/fake-scanner.ts`, so no native core is needed. Run a live-core variant only for the top-level factories.
- Run: `npx vitest run packages/<name>/test/<file>.fuzz.test.ts`. Set the run count with `fc.assert(..., { numRuns: N, seed })`; default to 2000, and use the argument as `N`. Print the seed on failure.

## Invariants

Generators: strings mixing the fake scanner's magic token (`SECRET_TOKEN_7`) with arbitrary text and Unicode (ZWJ emoji, RTL, combining, lone surrogates, Cf characters, `unit: "binary"`); value trees of objects, arrays, `Error`s, class instances, null-prototype objects, and `__proto__` keys, with cycles and shared references; throwing getters and `toJSON()`; limits from zero to just above `DEFAULT_LIMITS`; scanners that throw, reject, return malformed results, or report `block`, `warn`, `redact`, or `allow`.

1. **Never throws, always fixed shape.** Masking any input returns a value; it never throws through to the host, and a failing scanner yields `[REDACTED:ERROR]`, never the input or the error's message.
2. **No plaintext survives.** No planted synthetic secret appears in the output of `maskLeafWith`, `maskSecretsWith`, or the adapter's tree walk for any placement, split point, or tree position, including inside object keys where the adapter scans keys.
3. **Whole-leaf block.** A `block` finding replaces the entire leaf with `[REDACTED:BLOCKED]`, never just the matched span.
4. **Budget conservation.** The output never has more than `maxDepth`, `maxArrayLength`, `maxObjectKeys`, or `maxTotalLeaves` allows, and an oversize string is `[REDACTED:LIMIT_EXCEEDED]` and never reaches the scanner. Elements past a limit are dropped, not passed through.
5. **Cycles terminate.** A self-referencing structure returns `[REDACTED:CYCLE]` and never recurses without bound.
6. **Idempotence.** Masking already-masked output changes nothing, and a `<rsv_…>` token-shaped string with no finding passes through byte-for-byte.
7. **All or nothing (AI-context and MCP).** Any `block`, limit, unsupported value, or core failure gives a `blocked` outcome with no value, never a partial masked copy. A stream releases nothing before a successful `finalize`, and a secret split at any chunk boundary is still caught.
8. **Fixed diagnostics.** No fixture value appears in any error (message, stack, JSON, own properties), warning, finding, or counter. Findings carry only `SAFE_FINDING_FIELDS`.
9. **pino line lexer.** For any generated JSON line, `streamWrite` keeps every key and non-string byte, masks every string value, and returns `{"msg":"[REDACTED:ERROR]"}` for a line it cannot lex, never the raw line.
10. **Cross-language parity.** Where a `fixtures/*.json` case set exists, generated inputs give the same outcome from the TypeScript and Python adapters (`python/tests`, pytest). Report a divergence as a finding.

## Output

For each violated invariant: the invariant, the fast-check seed and path, the shrunk counterexample with values replaced by fixture names, and the observed vs expected result. End with `N runs, seed S: all invariants held` or the violation count.

## Rules

- Synthetic values only. Never print plaintext from a failing case; name the fixture instead.
- Do not change product code. Propose a fixture case or test for each confirmed violation.
- The fuzz tests must stay fast and deterministic under `npm test`. Keep the default run count small in committed files and raise it only from the command line.
