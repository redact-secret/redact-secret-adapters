/**
 * The release plan's pure helpers (scripts/release-plan.mjs): the dist-tag
 * each npm version publishes under, and the $GITHUB_OUTPUT lines the
 * rehearsal and release workflows read it from. No registry access:
 * importing the module computes no plan.
 */

import { describe, expect, test } from "vitest";

import { distTagFor, outputLines, PACKAGES, planEntry, planTable, unreleasedDependencies } from "../release-plan.mjs";

describe("distTagFor", () => {
  test.each([
    ["0.1.1", "latest"],
    ["1.0.0", "latest"],
    ["1.0.0+build.5", "latest"],
    ["0.1.0-alpha", "alpha"],
    ["0.1.0-alpha.2", "alpha"],
    ["0.2.0-beta.1", "beta"],
    ["0.1.0-beta.2", "beta"],
    ["1.0.0-rc.1+build.5", "rc"],
    ["1.0.0-next-2", "next-2"],
  ])("%s publishes under %s", (version, tag) => {
    expect(distTagFor(version)).toBe(tag);
  });

  test.each([
    ["1.0.0-0", /can't be an npm dist-tag/],
    ["1.0.0-1.alpha", /can't be an npm dist-tag/],
    ["1.0.0-latest", /can't be an npm dist-tag/],
    ["0.1.0.alpha", /not a SemVer version/],
    ["01.0.0", /not a SemVer version/],
    ["", /not a SemVer version/],
  ])("%s is refused", (version, error) => {
    expect(() => distTagFor(version)).toThrow(error);
  });
});

describe("the plan", () => {
  const npmPkg = PACKAGES.find((p) => p.id === "adapter");
  const pypiPkg = PACKAGES.find((p) => p.registry === "pypi");

  test("every npm package carries a dist-tag and the PyPI package does not", () => {
    expect(planEntry(npmPkg, "0.1.1", false).distTag).toBe("latest");
    expect(planEntry(npmPkg, "0.1.0-alpha", false).distTag).toBe("alpha");
    expect(planEntry(pypiPkg, "0.1.0", true)).not.toHaveProperty("distTag");
  });

  test("the outputs name each npm package's dist-tag next to its version", () => {
    const plan = [planEntry(npmPkg, "0.1.0-alpha", false), planEntry(pypiPkg, "0.1.0", true)];
    const lines = outputLines(plan);
    expect(lines).toContain("publish_adapter=true");
    expect(lines).toContain("adapter_version=0.1.0-alpha");
    expect(lines).toContain("adapter_dist_tag=alpha");
    expect(lines).toContain("publish_python=false");
    expect(lines.some((l) => l.startsWith("python_dist_tag="))).toBe(false);
    expect(lines).toContain("any_publish=true");
    const json = JSON.parse(lines.find((l) => l.startsWith("plan=")).slice("plan=".length));
    expect(json).toEqual([
      {
        name: "@redact-secret/adapter",
        registry: "npm",
        version: "0.1.0-alpha",
        publish: true,
        gitTag: "adapter@0.1.0-alpha",
        distTag: "alpha",
      },
      {
        name: "redact-secret-adapters",
        registry: "pypi",
        version: "0.1.0",
        publish: false,
        gitTag: "redact-secret-adapters@0.1.0",
      },
    ]);
  });

  test("any_publish is false when everything is published", () => {
    expect(outputLines([planEntry(npmPkg, "0.1.1", true)])).toContain("any_publish=false");
  });

  test("the table shows the dist-tag", () => {
    expect(planTable([planEntry(npmPkg, "0.1.0-alpha", false)])).toContain(
      "| @redact-secret/adapter | npm | 0.1.0-alpha | alpha | **publish** |",
    );
  });

  test("a package depending on an unreleased workspace package is caught (#49)", () => {
    const workspaces = new Set([
      "@redact-secret/adapter",
      "@redact-secret/adapter-otel-trace",
      "@redact-secret/adapter-otel",
    ]);
    const released = new Set(PACKAGES.map((p) => p.name));
    const shim = { dependencies: { "@redact-secret/adapter-otel-trace": "^0.1.0", tslib: "^2.0.0" } };
    expect(unreleasedDependencies(shim, workspaces, released)).toEqual(
      released.has("@redact-secret/adapter-otel-trace") ? [] : ["@redact-secret/adapter-otel-trace"],
    );
    expect(
      unreleasedDependencies(shim, workspaces, new Set([...released, "@redact-secret/adapter-otel-trace"])),
    ).toEqual([]);
    expect(
      unreleasedDependencies({ dependencies: { "@redact-secret/adapter": "^0.1.3" } }, workspaces, released),
    ).toEqual([]);
    expect(unreleasedDependencies({}, workspaces, released)).toEqual([]);
  });

  test("the adapter-otel-trace and adapter-otel manifests agree with the release plan (#49)", async () => {
    const { readFileSync } = await import("node:fs");
    const read = (path) => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), "utf-8"));
    const trace = read("packages/adapter-otel-trace/package.json");
    const shim = read("packages/adapter-otel/package.json");
    const ids = PACKAGES.map((p) => p.id);
    // Unreleased means private and unplanned; released means planned before the name that re-exports it.
    expect(trace.private === true).toBe(!ids.includes("adapter_otel_trace"));
    if (ids.includes("adapter_otel_trace")) {
      expect(ids.indexOf("adapter_otel_trace")).toBeLessThan(ids.indexOf("adapter_otel"));
    }
    expect(shim.dependencies).toEqual({ "@redact-secret/adapter-otel-trace": expect.any(String) });
    expect(shim.peerDependencies).toEqual(trace.peerDependencies);
  });

  test("adapter-otel-logs 0.1.0-beta.2 is planned after adapter, under dist-tag beta, and no longer private", async () => {
    const { readFileSync } = await import("node:fs");
    const manifest = JSON.parse(
      readFileSync(new URL("../../packages/adapter-otel-logs/package.json", import.meta.url), "utf-8"),
    );
    const pkg = PACKAGES.find((p) => p.id === "adapter_otel_logs");
    expect(pkg).toMatchObject({ name: manifest.name, tag: "adapter-otel-logs", registry: "npm" });
    expect(manifest.private).toBeUndefined();
    expect(manifest.version).toBe("0.1.0-beta.2");
    expect(PACKAGES.findIndex((p) => p.id === "adapter_otel_logs")).toBeGreaterThan(
      PACKAGES.findIndex((p) => p.id === "adapter"),
    );
    // Hand-published bootstrap: already on the registry, so the plan skips the publish but still tags it.
    const entry = planEntry(pkg, "0.1.0-beta.2", true);
    expect(entry).toMatchObject({ publish: false, distTag: "beta", gitTag: "adapter-otel-logs@0.1.0-beta.2" });
    expect(planEntry(pkg, "0.1.0-beta.2", false).publish).toBe(true);
    expect(outputLines([entry])).toEqual(
      expect.arrayContaining([
        "publish_adapter_otel_logs=false",
        "adapter_otel_logs_version=0.1.0-beta.2",
        "adapter_otel_logs_dist_tag=beta",
      ]),
    );
  });

  test("every npm package's declared version has a dist-tag", async () => {
    const { readFileSync } = await import("node:fs");
    for (const pkg of PACKAGES.filter((p) => p.registry === "npm")) {
      const { version } = JSON.parse(readFileSync(new URL(`../../${pkg.manifest}`, import.meta.url), "utf-8"));
      expect(() => distTagFor(version)).not.toThrow();
    }
  });
});
