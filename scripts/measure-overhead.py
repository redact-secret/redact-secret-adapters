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
"""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import logging
import math
import os
import platform
import statistics
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
from overhead_workloads import build_events, load_profiles, workload_digest  # noqa: E402

HOSTS = ("python-logging", "otel-python", "mask-python")
MODES = ("host", "adapter-identity", "adapter-core", "core-direct")


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


def _logging_runner(scanner: Optional[Callable[..., Any]]) -> Callable[[dict[str, Any]], None]:
    from redact_secret_adapters.logging_filter import RedactSecretFilter

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


def _otel_runner(scanner: Optional[Callable[..., Any]]) -> Callable[[dict[str, Any]], None]:
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor, SpanExporter, SpanExportResult
    from redact_secret_adapters.otel import RedactingSpanProcessorWith

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


def _mask_runner(scanner: Optional[Callable[..., Any]]) -> Callable[[dict[str, Any]], None]:
    from redact_secret_adapters.mask_secrets import mask_secrets_with

    if scanner is None:
        # There is no host around a masking callback: the baseline is the empty call.
        return lambda _event: None
    return lambda event: mask_secrets_with(scanner, event)


RUNNERS = {"python-logging": _logging_runner, "otel-python": _otel_runner, "mask-python": _mask_runner}


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


def measure_pair(host: str, profile: dict[str, Any], events: list, core: Callable[..., Any], args) -> dict[str, Any]:
    make = RUNNERS[host]
    leaves: list[list[str]] = []
    for event in events:
        recorded: list[str] = []

        def recording(text: str, policy: Any = None, _into: list = recorded) -> _Identity:
            _into.append(text)
            return _Identity(text)

        make(recording)(event)
        leaves.append(recorded)

    cursor = [0]

    def core_direct(_event: dict[str, Any]) -> None:
        for text in leaves[cursor[0]]:
            core(text)
        cursor[0] = (cursor[0] + 1) % len(leaves)

    runners = {
        "host": make(None),
        "adapter-identity": make(identity_scanner),
        "adapter-core": make(core),
        "core-direct": core_direct,
    }

    def run(mode: str, count: int) -> None:
        runner = runners[mode]
        for k in range(count):
            runner(events[k % len(events)])

    for mode in MODES:
        run(mode, args.warmup)
    samples: dict[str, list[float]] = {mode: [] for mode in MODES}
    for rep in range(args.repetitions):
        for m in range(len(MODES)):
            mode = MODES[(m + rep) % len(MODES)]
            started = time.perf_counter_ns()
            run(mode, args.events)
            samples[mode].append((time.perf_counter_ns() - started) / 1000 / args.events)

    modes = {mode: _summarize(samples[mode]) for mode in MODES}
    median = lambda mode: modes[mode]["median"]  # noqa: E731
    return {
        "host": host,
        "profileId": profile["id"],
        "scannerCallsPerEvent": round(sum(map(len, leaves)) / len(leaves), 3),
        "scannedCodeUnitsPerEvent": round(sum(sum(len(t) for t in leaf) for leaf in leaves) / len(leaves), 3),
        "modes": modes,
        "derived": {
            "unit": "microseconds-per-event",
            "basis": "difference of per-mode medians",
            "traversal": round(median("adapter-identity") - median("host"), 3),
            "coreScan": median("core-direct"),
            "adapterOverhead": round(median("adapter-core") - median("host"), 3),
            "unattributed": round(median("adapter-core") - median("adapter-identity") - median("core-direct"), 3),
        },
    }


def _git_state() -> dict[str, Any]:
    try:
        commit = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
        dirty = subprocess.check_output(["git", "status", "--porcelain"], text=True).strip() != ""
        return {"commit": commit, "dirty": dirty}
    except (OSError, subprocess.CalledProcessError):
        return {"commit": None, "dirty": None}


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
    args = parser.parse_args()
    if args.quick:
        args.repetitions, args.events, args.warmup = 3, 20, 5
    if args.repetitions < 1 or args.events < 1 or args.warmup < 0:
        parser.error("--repetitions and --events must be positive, --warmup non-negative")

    import redact_secret

    load_at_start = os.getloadavg()[0] if hasattr(os, "getloadavg") else None

    hosts = [host for host in args.host.split(",") if host in HOSTS]
    only = None if args.profile is None else set(args.profile.split(","))
    document = load_profiles()
    results = []
    for profile in document["profiles"]:
        if only is not None and profile["id"] not in only:
            continue
        events = build_events(document, profile)
        for host in (h for h in profile["hosts"] if h in hosts):
            result = measure_pair(host, profile, events, redact_secret.scan_and_redact, args)
            results.append(result)
            d = result["derived"]
            print(
                f"{host}/{profile['id']}: host {result['modes']['host']['median']}µs, traversal {d['traversal']}µs, "
                f"core {d['coreScan']}µs, overhead {d['adapterOverhead']}µs per event",
                file=sys.stderr,
            )

    output = {
        "schema": "redact-secret-adapters/overhead-v1",
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
            "processes": 1,
        },
        "results": results,
        "limitations": [
            "Host-dependent: these numbers describe this machine and runtime only.",
            "Per-event times are batch means over eventsPerRepetition events; "
            "the distribution is across repetitions, not across single events.",
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
