/**
 * Machine identity in the overhead harnesses (#108): a container cannot see
 * the host CPU, so the wrapper passes it in and the harness must prefer it,
 * keep the container-visible value, and report one arch string per machine.
 * All values are synthetic.
 */

import { expect, test } from "vitest";

import {
  cleanCpuModel,
  cpuEnvironment,
  HOST_CPU_ENV,
  normalizeArch,
  resolveCpuModel,
  visibleCpuModel,
} from "../bench-environment.mjs";

const HOST = "Synthetic Host CPU 9000";

test("arch is one string per machine whichever runtime reports it", () => {
  expect(normalizeArch("aarch64")).toBe("arm64");
  expect(normalizeArch("arm64")).toBe("arm64");
  expect(normalizeArch("x86_64")).toBe("x64");
  expect(normalizeArch("amd64")).toBe("x64");
  expect(normalizeArch("x64")).toBe("x64");
  expect(normalizeArch("riscv64")).toBe("riscv64");
});

test("placeholder and empty CPU models are not a model", () => {
  for (const value of ["unknown", "Unknown", "unknown-cpu", "", "   ", undefined, null]) {
    expect(cleanCpuModel(value)).toBeNull();
  }
  expect(cleanCpuModel("  Synthetic CPU  ")).toBe("Synthetic CPU");
  expect(visibleCpuModel([{ model: "unknown" }])).toBeNull();
  expect(visibleCpuModel([])).toBeNull();
});

test("the host model from the wrapper wins and the container value is kept", () => {
  const resolved = resolveCpuModel({ [HOST_CPU_ENV]: HOST }, "Synthetic Container CPU");
  expect(resolved).toEqual({
    cpuModel: HOST,
    cpuModelContainer: "Synthetic Container CPU",
    cpuModelSource: "host-env",
  });
});

test("without the wrapper the visible model is used", () => {
  expect(resolveCpuModel({}, "Synthetic Visible CPU")).toEqual({
    cpuModel: "Synthetic Visible CPU",
    cpuModelContainer: "Synthetic Visible CPU",
    cpuModelSource: "container",
  });
});

test("a placeholder host value is ignored and no model at all is reported as unavailable", () => {
  expect(resolveCpuModel({ [HOST_CPU_ENV]: "unknown" }, null)).toEqual({
    cpuModel: null,
    cpuModelContainer: null,
    cpuModelSource: "unavailable",
  });
});

test("the environment of a container that sees no CPU still carries the host's", () => {
  const environment = cpuEnvironment({ [HOST_CPU_ENV]: HOST }, [{ model: "unknown" }], "arm64");
  expect(environment).toEqual({
    arch: "arm64",
    archRaw: "arm64",
    cpuModel: HOST,
    cpuModelContainer: null,
    cpuModelSource: "host-env",
  });
});
