/**
 * The adapter release feed (scripts/generate-site-feed.mjs, #61): generated
 * only from the release plan, the manifests and compatibility.json, byte-for-
 * byte reproducible, valid against its own schema, and committed current.
 * No registry or network access.
 */

import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import {
  buildFeed,
  FEED_PATH,
  pypiChannel,
  renderFeed,
  SCHEMA_PATH,
  SCHEMA_VERSION,
  schemaErrors,
  sourcePaths,
} from "../generate-site-feed.mjs";
import { PACKAGES } from "../release-plan.mjs";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf-8");
const schema = JSON.parse(read(SCHEMA_PATH));

function inputs() {
  return {
    compatibility: JSON.parse(read("compatibility.json")),
    manifests: Object.fromEntries(PACKAGES.map((pkg) => [pkg.manifest, read(pkg.manifest)])),
  };
}

/** The same inputs with one npm manifest's JSON edited. */
function withManifest(base, path, edit) {
  const manifest = JSON.parse(base.manifests[path]);
  edit(manifest);
  return { ...base, manifests: { ...base.manifests, [path]: JSON.stringify(manifest) } };
}

describe("the committed feed", () => {
  test("is exactly what the generator produces from this tree", () => {
    expect(read(FEED_PATH)).toBe(renderFeed(buildFeed(inputs())));
  });

  test("is valid against its schema", () => {
    expect(schemaErrors(JSON.parse(read(FEED_PATH)), schema)).toEqual([]);
  });

  test("lists every released package once, in release-plan order", () => {
    const feed = JSON.parse(read(FEED_PATH));
    expect(feed.schemaVersion).toBe(SCHEMA_VERSION);
    expect(feed.packages.map((p) => p.name)).toEqual(PACKAGES.map((p) => p.name));
    expect(feed.sources).toEqual(sourcePaths());
  });
});

describe("buildFeed", () => {
  test("is deterministic: two builds from the same inputs render identical bytes", () => {
    expect(renderFeed(buildFeed(inputs()))).toBe(renderFeed(buildFeed(inputs())));
  });

  test("takes generatedAt from compatibility.json, not the clock", () => {
    const base = inputs();
    const moved = { ...base, compatibility: { ...base.compatibility, endpointsResolvedAt: "2031-01-02" } };
    expect(buildFeed(moved).generatedAt).toBe("2031-01-02T00:00:00Z");
    expect(buildFeed(base).generatedAt).toBe(`${base.compatibility.endpointsResolvedAt}T00:00:00Z`);
  });

  test("a version bump in a manifest moves the version, channel and tag", () => {
    const bumped = withManifest(inputs(), "packages/adapter-pino/package.json", (m) => {
      m.version = "0.2.0-beta.1";
    });
    const pino = buildFeed(bumped).packages.find((p) => p.id === "adapter-pino");
    expect(pino).toMatchObject({ version: "0.2.0-beta.1", channel: "beta", prerelease: true });
    expect(pino.gitTag).toBe("adapter-pino@0.2.0-beta.1");
    expect(schemaErrors(buildFeed(bumped), schema)).toEqual([]);
  });

  test("splits the core from host ranges and keeps the tested endpoints", () => {
    const feed = buildFeed(inputs());
    for (const pkg of feed.packages) {
      expect(["@redact-secret/core", "redact-secret"]).toContain(pkg.core.name);
      expect(pkg.hosts.map((h) => h.name)).not.toContain(pkg.core.name);
    }
    const python = feed.packages.find((p) => p.ecosystem === "pypi");
    expect(python.hosts).toContainEqual(expect.objectContaining({ name: "opentelemetry-sdk", extra: "otel" }));
  });

  test("records sibling dependencies only", () => {
    const mcp = buildFeed(inputs()).packages.find((p) => p.id === "adapter-mcp");
    expect(mcp.dependsOn.map((d) => d.name)).toEqual(["@redact-secret/adapter-ai-context"]);
  });

  test("adapter-otel keeps the core and host ranges its published releases declared (#49)", () => {
    const shim = buildFeed(inputs()).packages.find((p) => p.id === "adapter-otel");
    expect(shim.core.range).toBe("^0.1.0-beta.6");
    expect(shim.hosts.map((h) => [h.name, h.range])).toEqual([["@opentelemetry/sdk-trace-base", "^2.0.0"]]);
    // adapter-otel-trace is listed once a train releases it, and not before.
    const trace = buildFeed(inputs()).packages.find((p) => p.id === "adapter-otel-trace");
    expect(trace === undefined).toBe(!PACKAGES.some((p) => p.id === "adapter_otel_trace"));
  });

  test("refuses a private package in the release plan", () => {
    const privatised = withManifest(inputs(), "packages/adapter/package.json", (m) => {
      m.private = true;
    });
    expect(() => buildFeed(privatised)).toThrow(/private package/);
  });

  test("refuses an unknown compatibility record schema", () => {
    const base = inputs();
    expect(() => buildFeed({ ...base, compatibility: { ...base.compatibility, schema: "x/v9" } })).toThrow(
      /unsupported schema/,
    );
  });

  test("a feed missing a required field fails the schema", () => {
    const { generatedAt: _, ...feed } = buildFeed(inputs());
    expect(schemaErrors(feed, schema).join("\n")).toMatch(/generatedAt/);
  });

  test("a feed with an unknown schemaVersion fails the schema", () => {
    const feed = { ...buildFeed(inputs()), schemaVersion: "redact-secret-adapters.release-feed/v2" };
    expect(schemaErrors(feed, schema)).not.toEqual([]);
  });
});

describe("pypiChannel", () => {
  test.each([
    ["0.1.1", "latest"],
    ["1.0.0.post1", "latest"],
    ["0.1.0a2", "alpha"],
    ["0.1.0b10", "beta"],
    ["1.0.0rc1", "rc"],
    ["1.0.0.dev3", "dev"],
  ])("%s is on %s", (version, channel) => {
    expect(pypiChannel(version)).toBe(channel);
  });

  test.each(["0.1.0-alpha", "v1.0.0", "1.0.0alpha1", ""])("%s is refused", (version) => {
    expect(() => pypiChannel(version)).toThrow(/PEP 440/);
  });
});
