#!/usr/bin/env node
/**
 * Clean-install smoke test for `@redact-secret/adapter-otel-logs`
 * (redact-secret/redact-secret-adapters#178).
 *
 * Packs `@redact-secret/adapter` and `@redact-secret/adapter-otel-logs`,
 * installs the two tarballs into a throwaway project OUTSIDE the checkout
 * together with one endpoint of the declared `@opentelemetry/sdk-logs` range
 * and the real `@redact-secret/core`, and then:
 *
 *   1. serializes one record through a real LoggerProvider and a real
 *      BatchLogRecordProcessor with the OTLP/JSON serializer and asserts on
 *      the bytes (a script that adapts to the SDK's constructor shape, which
 *      changed inside the range);
 *   2. at the highest endpoint, runs the package README's example verbatim;
 *   3. typechecks a consumer file against the installed `.d.ts` files.
 *
 *   node scripts/smoke-test-otel-logs.mjs [highest|lowest]   (default: highest)
 *
 * The package is `"private": true` until it is released, so this installs the
 * tarball `npm pack` makes, never a registry copy. The sibling `adapter` is
 * the checkout's tarball for the same reason: the registry's may be older.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const end = process.argv[2] ?? "highest";
if (end !== "lowest" && end !== "highest") {
  console.error("usage: smoke-test-otel-logs.mjs [highest|lowest]");
  process.exit(2);
}

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const manifestFor = (dir) => JSON.parse(readFileSync(join(repoRoot, "packages", dir, "package.json"), "utf-8"));

function npm(args, cwd) {
  console.log(`+ npm ${args.join(" ")}  (in ${cwd})`);
  execFileSync("npm", args, { cwd, stdio: "inherit" });
}

function resolveEnd(name, range) {
  const versions = [
    JSON.parse(execFileSync("npm", ["view", `${name}@${range}`, "version", "--json"], { encoding: "utf-8" })),
  ].flat();
  return end === "lowest" ? versions[0] : versions.at(-1);
}

/** The fenced `js` block right after `<!-- smoke-test:example -->` in the package README. */
function readmeExample() {
  const readme = readFileSync(join(repoRoot, "packages", "adapter-otel-logs", "README.md"), "utf-8");
  const match = /<!-- smoke-test:example -->\s*```js\n([\s\S]*?)```/.exec(readme);
  if (match === null) throw new Error("adapter-otel-logs/README.md has no smoke-test:example block");
  return match[1];
}

function run(projectDir, script, args = []) {
  console.log(`+ node ${script}`);
  return execFileSync(process.execPath, [script, ...args], {
    cwd: projectDir,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

/** Every log record in the OTLP/JSON request bodies printed one per line. */
const otlpRecords = (printed) =>
  printed
    .trim()
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .flatMap((line) => JSON.parse(line).resourceLogs.flatMap((r) => r.scopeLogs.flatMap((s) => s.logRecords)));

const stringAttribute = (attributes, key) => attributes?.find((a) => a.key === key)?.value?.stringValue;

function main() {
  const logsManifest = manifestFor("adapter-otel-logs");
  const sdkRange = logsManifest.peerDependencies["@opentelemetry/sdk-logs"];
  const sdkVersion = resolveEnd("@opentelemetry/sdk-logs", sdkRange);
  console.log(`@opentelemetry/sdk-logs ${end} endpoint of ${sdkRange}: ${sdkVersion}`);

  const root = mkdtempSync(join(realpathSync(tmpdir()), "redact-secret-logs-pack-"));
  const packsDir = join(root, "packs");
  const projectDir = join(root, "project");
  mkdirSync(packsDir);
  mkdirSync(projectDir);
  console.log(`throwaway project: ${projectDir} (outside ${repoRoot})`);

  let ok = false;
  try {
    const tarballs = {};
    for (const dir of ["adapter", "adapter-otel-logs"]) {
      const out = JSON.parse(
        execFileSync("npm", ["pack", "--json", "--workspace", manifestFor(dir).name, "--pack-destination", packsDir], {
          cwd: repoRoot,
          encoding: "utf-8",
        }),
      );
      tarballs[dir] = join(packsDir, out[0].filename);
    }

    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "redact-secret-adapters-logs-smoke", private: true, type: "module" }, null, 2),
    );

    // The sibling first: if it were not already installed from its tarball, npm
    // would resolve it from the registry, which may be an older build.
    npm(["install", tarballs.adapter], projectDir);
    const adapterManifest = manifestFor("adapter");
    const rootManifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));
    npm(
      [
        "install",
        tarballs["adapter-otel-logs"],
        `@opentelemetry/sdk-logs@${sdkVersion}`,
        `@opentelemetry/otlp-transformer@${logsManifest.devDependencies["@opentelemetry/otlp-transformer"]}`,
        `@redact-secret/core@${adapterManifest.peerDependencies["@redact-secret/core"]}`,
        `typescript@${rootManifest.devDependencies.typescript}`,
        `@types/node@${rootManifest.devDependencies["@types/node"]}`,
      ],
      projectDir,
    );

    const installed = JSON.parse(
      readFileSync(join(projectDir, "node_modules", "@opentelemetry", "sdk-logs", "package.json"), "utf-8"),
    ).version;
    if (installed !== sdkVersion) throw new Error(`expected sdk-logs ${sdkVersion} installed, found ${installed}`);

    // 1. Bytes through a real provider and a real Batch processor, on the real core.
    writeFileSync(join(projectDir, "bytes.mjs"), BYTES_MJS);
    const printed = run(projectDir, "bytes.mjs");
    const [record] = otlpRecords(printed);
    if (
      printed.includes("ghp_SYNTHETIC") ||
      record?.body?.stringValue !== "deploy with token <SECRET_1>" ||
      stringAttribute(record.attributes, "exception.message") !== "denied for <SECRET_1>" ||
      !/^<SECRET_1>$/.test(
        Buffer.from(record.attributes.find((a) => a.key === "blob")?.value?.bytesValue ?? "", "base64").toString(),
      )
    ) {
      throw new Error(`adapter-otel-logs: unexpected exporter bytes ${printed}`);
    }
    console.log(`@redact-secret/adapter-otel-logs: exporter bytes ok at sdk-logs ${sdkVersion}`);

    // 2. The README example, verbatim. It uses the constructor shape of the
    // current SDK line, so it runs at the highest endpoint only.
    if (end === "highest") {
      writeFileSync(join(projectDir, "readme-example.mjs"), readmeExample());
      const exampleOut = run(projectDir, "readme-example.mjs");
      const [exampleRecord] = otlpRecords(exampleOut);
      if (
        exampleOut.includes("ghp_SYNTHETIC") ||
        exampleRecord?.body?.stringValue !== "deploy with token <SECRET_1>" ||
        stringAttribute(exampleRecord.attributes, "http.url") !== "https://example.test/reset?token=<SECRET_1>"
      ) {
        throw new Error(`adapter-otel-logs: the README example printed unexpected bytes ${exampleOut}`);
      }
      console.log("@redact-secret/adapter-otel-logs: README example ok");
    }

    // 3. Types resolve for a consumer, typechecked against the installed `.d.ts`.
    writeFileSync(join(projectDir, "smoke-test.ts"), SMOKE_TEST_TS);
    writeFileSync(join(projectDir, "tsconfig.json"), TSCONFIG_JSON);
    console.log("+ tsc -p tsconfig.json");
    execFileSync(join(projectDir, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], {
      cwd: projectDir,
      stdio: "inherit",
    });

    console.log(
      `\nsmoke test passed: adapter-otel-logs installs, runs, and typechecks from outside the workspace (${end}).`,
    );
    ok = true;
  } finally {
    if (ok) rmSync(root, { recursive: true, force: true });
    else console.error(`\nsmoke test failed — throwaway project left at ${root} for inspection`);
  }
}

// One record through the live factory, a real LoggerProvider and a real
// BatchLogRecordProcessor, serialized with the OTLP/JSON serializer. The SDK's
// own constructors changed shape inside the declared range, so both are
// detected rather than assumed. Synthetic values only.
const BYTES_MJS = `import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { JsonLogsSerializer } from "@opentelemetry/otlp-transformer";
import { createRedactingLogRecordProcessor } from "@redact-secret/adapter-otel-logs";
const token = "ghp_SYNTHETICREVOKED00000000000000000000";
const exporter = {
  export(records, done) { process.stdout.write(new TextDecoder().decode(JsonLogsSerializer.serializeRequest(records)) + "\\n"); done({ code: 0 }); },
  shutdown: async () => {},
  forceFlush: async () => {},
};
const probe = new BatchLogRecordProcessor({ exporter });
const batch = probe._exporter === exporter ? probe : new BatchLogRecordProcessor(exporter);
const redacting = await createRedactingLogRecordProcessor(batch);
// The \`processors\` config option arrived in 0.201; releases that still have addLogRecordProcessor register through it.
let provider = new LoggerProvider();
if (typeof provider.addLogRecordProcessor === "function") provider.addLogRecordProcessor(redacting);
else provider = new LoggerProvider({ processors: [redacting] });
provider.getLogger("smoke-test").emit({
  body: \`deploy with token \${token}\`,
  attributes: {
    "http.url": \`https://example.test/reset?token=\${token}\`,
    "exception.message": \`denied for \${token}\`,
    blob: new TextEncoder().encode(token),
  },
});
await provider.shutdown();
`;

const SMOKE_TEST_TS = `import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import {
  createRedactingLogRecordProcessor,
  type CreateRedactingLogRecordProcessorOptions,
  type OtelLogRecordOutcome,
  RedactingLogRecordProcessorWith,
} from "@redact-secret/adapter-otel-logs";

declare const next: LogRecordProcessor;

const options: CreateRedactingLogRecordProcessorOptions = {
  pii: ["pii:global"],
  maxStringLength: 1000,
  limits: { maxDepth: 4 },
  onOutcome: (outcome: OtelLogRecordOutcome) => {
    const unit: "log-record" = outcome.unit;
    const dropped: boolean = outcome.dropped;
    void [unit, dropped, outcome.values.redacted];
  },
};

const processor: Promise<RedactingLogRecordProcessorWith> = createRedactingLogRecordProcessor(next, options);
const asHostProcessor: Promise<LogRecordProcessor> = processor;
void asHostProcessor;
`;

const TSCONFIG_JSON = JSON.stringify(
  {
    compilerOptions: {
      target: "es2022",
      lib: ["es2022", "dom"],
      module: "nodenext",
      moduleResolution: "nodenext",
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      types: ["node"],
    },
    include: ["smoke-test.ts"],
  },
  null,
  2,
);

main();
