# Measuring overhead

Two harnesses time the adapters. Neither carries a threshold or a verdict:
the numbers depend on the host, so the baseline and any budget over it live in
[redact-secret-benchmarks](https://github.com/redact-secret/redact-secret-benchmarks),
not here.

## Running it

```bash
npm run build && node scripts/measure-overhead.mjs --out overhead-js.json
pip install -e "./python[otel]" && python scripts/measure-overhead.py --out overhead-python.json
```

| Harness | Covers |
| --- | --- |
| `scripts/measure-overhead.mjs` | pino, OpenTelemetry JS, `maskSecrets`, the AI-context boundary, and the MCP boundary (whole-input and streamed) |
| `scripts/measure-overhead.py` | `logging`, OpenTelemetry Python, `mask_secrets` |

Both time the same workloads, built from
[`fixtures/overhead-profiles.json`](../fixtures/overhead-profiles.json):
typical log, span and payload events, a 1×/4×/16× scaling series, and events
past each `DEFAULT_LIMITS` bound.

Each harness keeps four costs apart:

1. the host alone;
2. the adapter's own traversal, over a scanner that finds nothing;
3. the core's scan of exactly the leaves the adapter hands it;
4. the host plus adapter plus the real core.

Each is measured in three separate passes: batch wall time, single-event
latency (median, p95, p99, maximum), and memory (bytes allocated per event in
JavaScript, tracemalloc's peak in Python, and garbage-collection count and
pause).

To measure one host only, pass `--host`, for example
`node scripts/measure-overhead.mjs --host ai-context-js`.

## Comparing releases

To compare against the previous release, install it into a prefix and pass
`--baseline`. Each harness then interleaves the previous release's modes with
the current build's in one session, sharing the host and the injected core,
and records for every result a `change` from baseline to current (a record,
not a verdict):

```bash
node scripts/install-overhead-baseline.mjs /tmp/overhead-baseline
node scripts/measure-overhead.mjs --baseline /tmp/overhead-baseline --out overhead-js.json
python scripts/install-overhead-baseline.py /tmp/overhead-baseline-python
python scripts/measure-overhead.py --baseline /tmp/overhead-baseline-python --out overhead-python.json
node scripts/summarize-overhead-change.mjs overhead-js.json overhead-python.json
```

`npm run bench:docker` (`-- --python` for the Python harness) does the same
inside [`docker/bench.Dockerfile`](../docker/bench.Dockerfile) or
[`docker/bench-python.Dockerfile`](../docker/bench-python.Dockerfile). The
runtime, the OS libraries, the core's native addon and the previous release
are pinned in the image, the container has no network, and the image id and
source commit are recorded in the output (`-- --cpuset 2,3` also pins CPUs).
The image fixes the software, not the hardware, so compare runs from different
machines only by their same-session `change`, never by absolute microseconds,
and never run it under emulation.

## Which values to read, in order

| Value | Why |
| --- | --- |
| `change.scannerCallsPerEvent` | Deterministic. If it moved, the two builds do different work, and a timing change between them is not like-for-like. |
| `change.traversal` | The adapter's own code only (walker and seam), independent of the core. This is the one to optimize. |
| `change.adapterCoreAllocatedBytesPerEvent` / `adapterCorePeakBytes` | Allocation moves first when a walker gets cheaper or more expensive. |
| `change.adapterCoreLatencyP95` / `P99` | The tail a logger or tracer notices. |
| `derived.adapterOverheadRatio` | Overhead as a fraction of the host's own time, for hosts that have one. |
| the `limit-*-over` rows | The fail-closed path past each limit. It must stay cheap. |

A change is only meaningful above the machine's noise floor. Measure it with
an A/A run, the current build against a copy of itself:
`npm run bench:docker -- --aa`, then `summarize-overhead-change.mjs` on its
output.

## One-off costs

`scripts/measure-footprint.mjs` (`npm run footprint`) records each npm
package's packed and unpacked size, and its initialization time in a fresh
process (importing the package, the core's own `initialize()` alone, and the
package's live factory end to end), so the adapter's share of start-up is
separable from the core's.

## OpenTelemetry Logs adapter (#178)

`adapter-otel-logs` is not yet part of `measure-overhead.mjs` or the
`redact-secret-benchmarks` baseline, and it has no previous release to compare
with. A local, single-machine measurement was recorded with
`npm run build && node scripts/measure-otel-logs-overhead.mjs` on 2026-10-01
(Node 22.16.0, `@opentelemetry/sdk-logs` 0.222.0, core `0.1.0-beta.12`, an
Apple-silicon laptop, 20 000 records per repetition, median of 7). The record
is a body of about 190 characters and eight short attributes, two of the strings
carrying a synthetic token shape (microseconds per record, median):

| Mode | Microseconds per record |
| --- | --- |
| `host`: a real `LoggerProvider` and a no-op processor, no wrapper | 0.75 |
| `adapter`: the wrapper over a scanner that finds nothing (its own traversal) | 1.04 |
| `adapter-core`: the wrapper over the real core | 23.94 |
| `core-direct`: the real core scanning the same eight string leaves | 22.38 |

Read as a record, not a verdict. Two runs on the same machine differed by up to
25 percent, so only the order of magnitude means anything: the wrapper's own
traversal is a fraction of a microsecond a record, and the cost of protecting a
record is the core's scan of its string leaves (about 2 microseconds each). `measure-footprint.mjs`
reports the package at 13 764 bytes packed, and 10.5 ms to import against
9.6 ms for `adapter-otel-trace` (core alone: 10.2 ms; live factory: 14.0 ms).
Absolute numbers depend on the machine; compare runs only on one machine.
Moving this into the shared harness, with a benchmarks baseline and an A/A
noise floor, is follow-up work in `redact-secret-benchmarks`.
