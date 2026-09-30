import { execFileSync } from "node:child_process";

/**
 * Builds every package before the suite runs. The no-host-import tests read
 * `dist/`, adapter-pino and adapter-otel-trace import `@redact-secret/adapter`
 * through its `dist/`, and adapter-otel imports `@redact-secret/adapter-otel-trace`
 * the same way, so a missing or stale build would otherwise be what gets tested.
 */
export default function setup(): void {
  execFileSync("npm", ["run", "build", "--silent"], { stdio: "inherit" });
}
