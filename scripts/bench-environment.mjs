/**
 * Machine identity for the adapter-overhead harnesses (#108).
 *
 * redact-secret-benchmarks keys a profile on `platform-arch|cpuModel|runtime`.
 * A container cannot see the host CPU (`os.cpus()[0].model` is "unknown" on
 * arm64 Linux), so `scripts/bench-docker.mjs` reads the host's model and
 * passes it in as REDACT_SECRET_BENCH_HOST_CPU. The harnesses prefer it and
 * keep the container-visible value beside it. `scripts/overhead_environment.py`
 * mirrors this logic; keep the two in step.
 */

import { execFileSync } from "node:child_process";
import os from "node:os";

export const HOST_CPU_ENV = "REDACT_SECRET_BENCH_HOST_CPU";

const ARCH_ALIASES = { aarch64: "arm64", arm64: "arm64", x86_64: "x64", amd64: "x64", x64: "x64" };

/** One arch string per machine, whichever runtime reports it. */
export function normalizeArch(arch) {
  return ARCH_ALIASES[String(arch).toLowerCase()] ?? String(arch);
}

/** A CPU model string, or null when it is empty or a placeholder such as "unknown". */
export function cleanCpuModel(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" || /^unknown(-cpu)?$/i.test(trimmed) ? null : trimmed;
}

/** The CPU model this process can see. */
export function visibleCpuModel(cpus = os.cpus()) {
  return cleanCpuModel(cpus[0]?.model);
}

/** The model to key a profile on: the host's when the wrapper passed it, else what is visible. */
export function resolveCpuModel(env = process.env, visible = visibleCpuModel()) {
  const host = cleanCpuModel(env[HOST_CPU_ENV]);
  return {
    cpuModel: host ?? visible,
    cpuModelContainer: visible,
    cpuModelSource: host !== null ? "host-env" : visible !== null ? "container" : "unavailable",
  };
}

/** The `environment` fields for CPU and arch. */
export function cpuEnvironment(env = process.env, cpus = os.cpus(), arch = os.arch()) {
  return { arch: normalizeArch(arch), archRaw: arch, ...resolveCpuModel(env, visibleCpuModel(cpus)) };
}

/** Reads the Docker host's CPU model (called by the container wrapper, on the host). */
export function readHostCpuModel(platform = process.platform) {
  if (platform === "darwin") {
    try {
      const brand = cleanCpuModel(execFileSync("sysctl", ["-n", "machdep.cpu.brand_string"], { encoding: "utf-8" }));
      if (brand !== null) return brand;
    } catch {
      // fall through to os.cpus()
    }
  }
  return visibleCpuModel();
}
