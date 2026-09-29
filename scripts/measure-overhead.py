#!/usr/bin/env python3
"""Adapter-only operational overhead (#11), Python hosts. Measures and
records; it carries no threshold and no verdict. Budgets and judgement
belong to redact-secret-benchmarks, which consumes this file's output.

    pip install -e "./python[otel]"
    python scripts/measure-overhead.py --out overhead-python.json
    python scripts/measure-overhead.py --quick --out -     # CI smoke: shape only, numbers meaningless

Same method as ``scripts/measure-overhead.mjs``: for every (host, profile)
pair it times four modes over the same events, interleaved and rotated per
repetition:

    host              the host alone (a logging handler, an OpenTelemetry provider), no adapter
    adapter-identity  host + adapter over a scanner that finds nothing: traversal and seam cost only
    adapter-core      host + adapter over the real ``redact_secret``
    core-direct       the real core called directly on exactly the leaves the adapter hands it

Each mode is measured in three separate passes, so one kind of measurement
never perturbs another: ``batch`` (wall time over a batch, the per-mode
medians), ``latency`` (every event timed on its own, for the tail) and
``memory`` (tracemalloc peak and garbage collections, after a forced
collection; tracemalloc slows everything it traces, so it runs only here).
"""

from __future__ import annotations

import argparse
import gc
import importlib
import importlib.metadata
import importlib.util
import json
import logging
import math
import os
import platform
import statistics
import subprocess
import sys
import time
import tracemalloc
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
from overhead_workloads import build_events, load_profiles, workload_digest  # noqa: E402

HOSTS = ("python-logging", "otel-python", "mask-python")
# Hosts whose host mode is the empty call: a ratio over it means nothing.
HOSTLESS = frozenset({"mask-python"})
MODES = ("host", "adapter-identity", "adapter-core", "core-direct")
# Under --baseline, the previous release's modes: the host alone is shared with the current build.
BASELINE_MODES = ("adapter-identity", "adapter-core", "core-direct")
PACKAGE = "redact_secret_adapters"
BASELINE_ALIAS = "overhead_baseline_redact_secret_adapters"


class _Identity:
    __slots__ = ("text", "findings")

    def __init__(self, text: str) -> None:
        self.text = text
        self.findings: list = []


def identity_scanner(text: str, policy: Any = None) -> _Identity:
    return _Identity(text)


class _NullStream:
    def write(self, _text: str) -> int:
        return 0

    def flush(self) -> None:
        pass


Load = Callable[[str], Any]


def _current(submodule: str) -> Any:
    return importlib.import_module(f"{PACKAGE}.{submodule}")


def _logging_runner(scanner: Optional[Callable[..., Any]], load: Load = _current) -> Callable[[dict[str, Any]], None]:
    RedactSecretFilter = load("logging_filter").RedactSecretFilter  # noqa: N806

    handler = logging.StreamHandler(_NullStream())
    handler.setFormatter(logging.Formatter("%(levelname)s %(message)s %(fields)s"))
    if scanner is not None:
        handler.addFilter(RedactSecretFilter(scanner, extra_fields=("fields",)))
    logger = logging.Logger(f"overhead-{id(handler)}", logging.INFO)
    logger.addHandler(handler)
    logger.propagate = False

    def run(event: dict[str, Any]) -> None:
        logger.info(event["message"], *event["args"], extra={"fields": event["fields"]})

    return run


def _otel_runner(scanner: Optional[Callable[..., Any]], load: Load = _current) -> Callable[[dict[str, Any]], None]:
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor, SpanExporter, SpanExportResult

    RedactingSpanProcessorWith = load("otel").RedactingSpanProcessorWith  # noqa: N806

    class _NullExporter(SpanExporter):
        def export(self, spans):
            return SpanExportResult.SUCCESS

        def shutdown(self) -> None:
            pass

    simple = SimpleSpanProcessor(_NullExporter())
    provider = TracerProvider()
    provider.add_span_processor(simple if scanner is None else RedactingSpanProcessorWith(simple, scanner))
    tracer = provider.get_tracer("overhead")

    def run(event: dict[str, Any]) -> None:
        span = tracer.start_span(event["name"])
        span.set_attributes(event["attributes"])
        for item in event["events"]:
            span.add_event(item["name"], item["attributes"])
        span.end()

    return run


def _mask_runner(scanner: Optional[Callable[..., Any]], load: Load = _current) -> Callable[[dict[str, Any]], None]:
    mask_secrets_with = load("mask_secrets").mask_secrets_with

    if scanner is None:
        # There is no host around a masking callback: the baseline is the empty call.
        return lambda _event: None
    return lambda event: mask_secrets_with(scanner, event)


RUNNERS = {"python-logging": _logging_runner, "otel-python": _otel_runner, "mask-python": _mask_runner}


class Baseline:
    """The previous release, installed by scripts/install-overhead-baseline.py
    into ``directory`` and imported under an alias beside the current build.
    Its modules import each other relatively, so the alias holds throughout."""

    def __init__(self, directory: str) -> None:
        root = Path(directory).resolve() / PACKAGE
        self.version: Optional[str] = None
        for info in root.parent.glob("redact_secret_adapters-*.dist-info"):
            self.version = info.name[len("redact_secret_adapters-") : -len(".dist-info")]
        self.error: Optional[str] = None
        spec = importlib.util.spec_from_file_location(
            BASELINE_ALIAS, root / "__init__.py", submodule_search_locations=[str(root)]
        )
        if spec is None or spec.loader is None or not (root / "__init__.py").exists():
            self.error = f"{PACKAGE} is not installed in {directory}"
            return
        module = importlib.util.module_from_spec(spec)
        sys.modules[BASELINE_ALIAS] = module
        spec.loader.exec_module(module)

    def load(self, submodule: str) -> Any:
        if self.error is not None:
            raise RuntimeError(self.error)
        return importlib.import_module(f"{BASELINE_ALIAS}.{submodule}")


def _percentile(ordered: list[float], p: float) -> float:
    """Nearest-rank percentile over sorted samples."""
    return ordered[max(0, math.ceil(p * len(ordered)) - 1)]


def _summarize(samples: list[float]) -> dict[str, Any]:
    ordered = sorted(samples)
    r = lambda x: round(x, 3)  # noqa: E731
    return {
        "unit": "microseconds-per-event",
        "samples": [r(x) for x in samples],
        "median": r(_percentile(ordered, 0.5)),
        "p95": r(_percentile(ordered, 0.95)),
        "minimum": r(ordered[0]),
        "maximum": r(ordered[-1]),
        "standardDeviation": r(statistics.pstdev(samples)),
    }


def _summarize_latency(samples: list[float]) -> dict[str, Any]:
    """Summary of single-event latencies, pooled over every repetition."""
    ordered = sorted(samples)
    r = lambda x: round(x, 3)  # noqa: E731
    return {
        "unit": "microseconds",
        "count": len(ordered),
        "median": r(_percentile(ordered, 0.5)),
        "p95": r(_percentile(ordered, 0.95)),
        "p99": r(_percentile(ordered, 0.99)),
        "maximum": r(ordered[-1]),
    }


def _summarize_memory(repetitions: list[dict[str, float]], events: int) -> dict[str, Any]:
    """Median over repetitions of peak traced memory and collection cost."""
    median = lambda key: _percentile(sorted(r[key] for r in repetitions), 0.5)  # noqa: E731
    return {
        "basis": "tracemalloc: peak traced bytes above the start of the batch; CPython exposes no allocation total",
        "allocatedBytesPerEvent": None,
        "peakBytes": median("peakBytes"),
        "gcCountPerEvent": round(median("gcCount") / events, 3),
        "gcPauseMicrosecondsPerEvent": round(median("gcPauseMicroseconds") / events, 3),
    }


def _measure_memory(work: Callable[[], None]) -> dict[str, float]:
    """Peak traced bytes and collections while ``work`` runs, from a freshly collected heap."""
    pauses: list[float] = []
    started: list[int] = []

    def on_gc(phase: str, _info: dict[str, Any]) -> None:
        if phase == "start":
            started.append(time.perf_counter_ns())
        elif started:
            pauses.append((time.perf_counter_ns() - started.pop()) / 1000)

    gc.collect()
    tracemalloc.start()
    gc.callbacks.append(on_gc)
    try:
        tracemalloc.reset_peak()
        base = tracemalloc.get_traced_memory()[0]
        work()
        peak = tracemalloc.get_traced_memory()[1] - base
    finally:
        gc.callbacks.remove(on_gc)
        tracemalloc.stop()
    return {"peakBytes": peak, "gcCount": len(pauses), "gcPauseMicroseconds": sum(pauses)}


def _build_runners(make: Callable[..., Any], load: Load, events: list, core: Callable[..., Any]) -> dict[str, Any]:
    """The four mode runners for one build of the adapter, and the leaves its core-direct scans.
    Recording the leaves runs every event through the build once, so a build that cannot run fails here."""
    leaves: list[list[str]] = []
    for event in events:
        recorded: list[str] = []

        def recording(text: str, policy: Any = None, _into: list = recorded) -> _Identity:
            _into.append(text)
            return _Identity(text)

        make(recording, load)(event)
        leaves.append(recorded)

    cursor = [0]

    def core_direct(_event: dict[str, Any]) -> None:
        for text in leaves[cursor[0]]:
            core(text)
        cursor[0] = (cursor[0] + 1) % len(leaves)

    return {
        "runners": {
            "host": make(None, load),
            "adapter-identity": make(identity_scanner, load),
            "adapter-core": make(core, load),
            "core-direct": core_direct,
        },
        "scannerCallsPerEvent": round(sum(map(len, leaves)) / len(leaves), 3),
        "scannedCodeUnitsPerEvent": round(sum(sum(len(t) for t in leaf) for leaf in leaves) / len(leaves), 3),
    }


def _derive(host: str, modes: dict[str, Any]) -> dict[str, Any]:
    median = lambda mode: modes[mode]["median"]  # noqa: E731
    overhead = median("adapter-core") - median("host")
    return {
        "unit": "microseconds-per-event",
        "basis": "difference of per-mode medians",
        "traversal": round(median("adapter-identity") - median("host"), 3),
        "coreScan": median("core-direct"),
        "adapterOverhead": round(overhead, 3),
        "unattributed": round(median("adapter-core") - median("adapter-identity") - median("core-direct"), 3),
        # No allocation total in CPython; the JavaScript harness fills this.
        "traversalAllocatedBytes": None,
        # adapterOverhead as a fraction of the host's own time; comparable across machines where µs are not.
        "adapterOverheadRatio": (
            None if host in HOSTLESS or not median("host") > 0 else round(overhead / median("host"), 3)
        ),
    }


# The values compared between the baseline and the current build, by name.
COMPARED: dict[str, Callable[[dict[str, Any]], Any]] = {
    "traversal": lambda r: r["derived"]["traversal"],
    "adapterOverhead": lambda r: r["derived"]["adapterOverhead"],
    "adapterOverheadRatio": lambda r: r["derived"]["adapterOverheadRatio"],
    "coreScan": lambda r: r["derived"]["coreScan"],
    "traversalAllocatedBytes": lambda r: r["derived"]["traversalAllocatedBytes"],
    "adapterCoreLatencyP95": lambda r: r["modes"]["adapter-core"]["latency"]["p95"],
    "adapterCoreLatencyP99": lambda r: r["modes"]["adapter-core"]["latency"]["p99"],
    "adapterCoreAllocatedBytesPerEvent": lambda r: r["modes"]["adapter-core"]["memory"]["allocatedBytesPerEvent"],
    "adapterCorePeakBytes": lambda r: r["modes"]["adapter-core"]["memory"]["peakBytes"],
    "scannerCallsPerEvent": lambda r: r["scannerCallsPerEvent"],
}


def _compare(baseline: dict[str, Any], current: dict[str, Any]) -> dict[str, Any]:
    """Baseline to current for every compared value: a record, not a verdict."""
    out = {}
    for name, read in COMPARED.items():
        before, after = read(baseline), read(current)
        usable = isinstance(before, (int, float)) and isinstance(after, (int, float))
        out[name] = {
            "baseline": before,
            "current": after,
            "difference": round(after - before, 3) if usable else None,
            "relative": round((after - before) / abs(before), 3) if usable and before != 0 else None,
        }
    return out


def measure_pair(
    host: str,
    profile: dict[str, Any],
    events: list,
    core: Callable[..., Any],
    args,
    baseline: Optional[Baseline] = None,
) -> dict[str, Any]:
    make = RUNNERS[host]
    # A heavy profile caps its own batch so a full run stays bounded; --quick still wins when smaller.
    per_repetition = min(args.events, profile.get("maxEventsPerRepetition", args.events))
    current = _build_runners(make, _current, events, core)
    runners = dict(current["runners"])
    order: tuple[str, ...] = MODES
    previous = None
    unavailable = None
    if baseline is not None:
        try:
            previous = _build_runners(make, baseline.load, events, core)
        except Exception as error:  # noqa: BLE001 - any failure means "cannot compare"
            unavailable = {"comparable": False, "reason": f"the baseline cannot run {host}: {error}"}
        if previous is not None:
            # The host alone is the same for both builds, so it is timed once.
            for mode in BASELINE_MODES:
                runners[f"baseline:{mode}"] = previous["runners"][mode]
            order = MODES + tuple(f"baseline:{mode}" for mode in BASELINE_MODES)

    def run(mode: str, count: int) -> None:
        runner = runners[mode]
        for k in range(count):
            runner(events[k % len(events)])

    for mode in order:
        run(mode, args.warmup)
    samples: dict[str, list[float]] = {mode: [] for mode in order}
    for rep in range(args.repetitions):
        for m in range(len(order)):
            mode = order[(m + rep) % len(order)]
            started = time.perf_counter_ns()
            run(mode, per_repetition)
            samples[mode].append((time.perf_counter_ns() - started) / 1000 / per_repetition)

    latencies: dict[str, list[float]] = {mode: [] for mode in order}
    for rep in range(args.repetitions):
        for m in range(len(order)):
            mode = order[(m + rep) % len(order)]
            runner = runners[mode]
            for k in range(per_repetition):
                event = events[k % len(events)]
                started = time.perf_counter_ns()
                runner(event)
                latencies[mode].append((time.perf_counter_ns() - started) / 1000)

    memory: dict[str, list[dict[str, float]]] = {mode: [] for mode in order}
    for rep in range(args.repetitions):
        for m in range(len(order)):
            mode = order[(m + rep) % len(order)]
            memory[mode].append(_measure_memory(lambda mode=mode: run(mode, per_repetition)))

    def summary(key: str) -> dict[str, Any]:
        return {
            **_summarize(samples[key]),
            "latency": _summarize_latency(latencies[key]),
            "memory": _summarize_memory(memory[key], per_repetition),
        }

    modes = {mode: summary(mode) for mode in MODES}
    result: dict[str, Any] = {
        "host": host,
        "profileId": profile["id"],
        "eventsPerRepetition": per_repetition,
        "scannerCallsPerEvent": current["scannerCallsPerEvent"],
        "scannedCodeUnitsPerEvent": current["scannedCodeUnitsPerEvent"],
        "modes": modes,
        "derived": _derive(host, modes),
    }
    if previous is not None:
        baseline_modes = {mode: summary(f"baseline:{mode}") for mode in BASELINE_MODES}
        measured = {
            "comparable": True,
            "scannerCallsPerEvent": previous["scannerCallsPerEvent"],
            "scannedCodeUnitsPerEvent": previous["scannedCodeUnitsPerEvent"],
            "modes": baseline_modes,
            "derived": _derive(host, {"host": modes["host"], **baseline_modes}),
        }
        result["baseline"] = measured
        result["change"] = _compare(measured, result)
    elif unavailable is not None:
        result["baseline"] = unavailable
    return result


def _git_state() -> dict[str, Any]:
    try:
        commit = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
        dirty = subprocess.check_output(["git", "status", "--porcelain"], text=True).strip() != ""
        return {"commit": commit, "dirty": dirty}
    except (OSError, subprocess.CalledProcessError):
        # No checkout (the bench container): the runner passes the source commit in.
        dirty = os.environ.get("REDACT_SECRET_BENCH_DIRTY")
        return {
            "commit": os.environ.get("REDACT_SECRET_BENCH_COMMIT") or None,
            "dirty": True if dirty == "true" else False if dirty == "false" else None,
        }


def _version(name: str) -> Optional[str]:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


def _cpu_model() -> Optional[str]:
    try:
        if sys.platform == "darwin":
            return subprocess.check_output(["sysctl", "-n", "machdep.cpu.brand_string"], text=True).strip()
        with open("/proc/cpuinfo", encoding="utf-8") as cpuinfo:
            for line in cpuinfo:
                if line.startswith("model name"):
                    return line.split(":", 1)[1].strip()
    except (OSError, subprocess.CalledProcessError):
        pass
    return platform.processor() or None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", default="-")
    parser.add_argument("--repetitions", type=int, default=15)
    parser.add_argument("--events", type=int, default=400)
    parser.add_argument("--warmup", type=int, default=200)
    parser.add_argument("--host", default=",".join(HOSTS))
    parser.add_argument("--profile", default=None)
    parser.add_argument("--quick", action="store_true")
    parser.add_argument("--baseline", default=None, help="a directory from scripts/install-overhead-baseline.py")
    args = parser.parse_args()
    if args.quick:
        args.repetitions, args.events, args.warmup = 3, 20, 5
    if args.repetitions < 1 or args.events < 1 or args.warmup < 0:
        parser.error("--repetitions and --events must be positive, --warmup non-negative")

    import redact_secret

    load_at_start = os.getloadavg()[0] if hasattr(os, "getloadavg") else None

    baseline = None if args.baseline is None else Baseline(args.baseline)
    hosts = [host for host in args.host.split(",") if host in HOSTS]
    only = None if args.profile is None else set(args.profile.split(","))
    document = load_profiles()
    results = []
    for profile in document["profiles"]:
        if only is not None and profile["id"] not in only:
            continue
        events = build_events(document, profile)
        for host in (h for h in profile["hosts"] if h in hosts):
            result = measure_pair(host, profile, events, redact_secret.scan_and_redact, args, baseline)
            results.append(result)
            d = result["derived"]
            print(
                f"{host}/{profile['id']}: host {result['modes']['host']['median']}µs, traversal {d['traversal']}µs, "
                f"core {d['coreScan']}µs, overhead {d['adapterOverhead']}µs per event",
                file=sys.stderr,
            )
            if "change" in result:
                t = result["change"]["traversal"]
                print(f"  baseline traversal {t['baseline']}µs -> {t['current']}µs", file=sys.stderr)
            elif "baseline" in result:
                print(f"  baseline not comparable: {result['baseline']['reason']}", file=sys.stderr)

    output = {
        "schema": "redact-secret-adapters/overhead-v2",
        "language": "python",
        "measuredAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "source": {"repository": "redact-secret/redact-secret-adapters", **_git_state()},
        "workloads": {
            "file": "fixtures/overhead-profiles.json",
            "schemaVersion": document["schemaVersion"],
            "digest": workload_digest(document),
        },
        "environment": {
            "os": f"{platform.system().lower()}-{platform.release()}",
            "platform": sys.platform,
            "arch": platform.machine(),
            "cpuModel": _cpu_model(),
            "logicalCpus": os.cpu_count(),
            "runtime": f"{sys.implementation.name}-{platform.python_version()}",
            # Set by the container wrapper; None for a run outside one.
            "containerImage": os.environ.get("REDACT_SECRET_BENCH_IMAGE") or None,
            # Other work on the machine is the main source of noise between runs.
            "loadAverage1m": {
                "start": load_at_start,
                "end": os.getloadavg()[0] if hasattr(os, "getloadavg") else None,
            },
            "packages": {
                name: _version(name) for name in ("redact-secret", "redact-secret-adapters", "opentelemetry-sdk")
            },
        },
        "method": {
            "quick": args.quick,
            "repetitions": args.repetitions,
            "eventsPerRepetition": args.events,
            "warmupEventsPerMode": args.warmup,
            "distinctEvents": document["distinctEvents"],
            "order": "modes interleaved within each repetition, rotated by one position per repetition",
            "clock": "time.perf_counter_ns",
            "percentile": "nearest-rank",
            "passes": ["batch", "latency", "memory"],
            "processes": 1,
        },
        # The previous release measured in this same session under --baseline; None otherwise.
        "baseline": None
        if baseline is None
        else {
            "packages": {"redact-secret-adapters": baseline.version},
            "order": "the previous release's adapter-identity, adapter-core and core-direct "
            "interleaved with the current modes; host is shared",
            "change": "per result: baseline to current, differences of medians; a record, not a verdict",
        },
        "results": results,
        "limitations": [
            "Host-dependent: these numbers describe this machine and runtime only.",
            "Per-event times are batch means over eventsPerRepetition events; "
            "the distribution is across repetitions, not across single events.",
            "Single-event latencies include one clock read of overhead each; "
            "memory repetitions start from a forced collection, which the batch and latency passes do not.",
            "memory is tracemalloc's peak, not an allocation total, and excludes native allocations inside the core.",
            "derived values are differences of medians, not medians of differences, and can be negative within noise.",
            "The OpenTelemetry exporter is a no-op and the logging stream discards writes, "
            "so export and I/O cost are excluded.",
            "This output carries no threshold and no verdict.",
        ],
    }
    text = json.dumps(output, indent=2) + "\n"
    if args.out == "-":
        sys.stdout.write(text)
    else:
        Path(args.out).write_text(text, encoding="utf-8")


if __name__ == "__main__":
    main()
