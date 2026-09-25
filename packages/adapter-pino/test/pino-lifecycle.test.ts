/**
 * Real-host lifecycle qualification for pino (#11): concurrent logging, the
 * host's own asynchronous transports, and downstream failure. CI runs this
 * at both ends of the declared `pino` peer range, like `pino-host.test.ts`.
 *
 * The scanner is the deterministic fake (`fixtures/fake-scanner.ts`). Every
 * event carries its own id and its own synthetic secret, so a line that
 * contains another event's id, a blocked marker it did not ask for, or any
 * `SECRET_TOKEN_` text at all is cross-event leakage.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as yieldToLoop } from "node:timers/promises";

import pino from "pino";
import { afterEach, expect, test } from "vitest";

import { fakeScanAndRedact } from "../../../fixtures/fake-scanner.js";
import { createRedactingLogMethodWith, createRedactingStreamWriteWith } from "../src/index.js";

const TASKS = 32;
const EVENTS_PER_TASK = 25;

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "adapter-pino-lifecycle-"));
  scratch.push(dir);
  return join(dir, name);
}

function hooks() {
  return {
    logMethod: createRedactingLogMethodWith(fakeScanAndRedact),
    streamWrite: createRedactingStreamWriteWith(fakeScanAndRedact),
  };
}

type Line = { id?: string; msg?: string; detail?: { note?: string; tags?: string[] }; task?: string; blocked?: string };

/** Logs every event from TASKS interleaved async tasks; every 7th event is a block event. */
async function logConcurrently(logger: pino.Logger): Promise<number> {
  let emitted = 0;
  await Promise.all(
    Array.from({ length: TASKS }, async (_, task) => {
      const child = logger.child({ task: `task-${task} SECRET_TOKEN_9${task}` });
      for (let index = 0; index < EVENTS_PER_TASK; index += 1) {
        const id = `${task}-${index}`;
        const blocked = (task * EVENTS_PER_TASK + index) % 7 === 0;
        child.info(
          {
            id,
            detail: { note: `event ${id} key SECRET_TOKEN_${task}${index}`, tags: [`tag ${id}`, "SECRET_TOKEN_7"] },
            ...(blocked ? { blocked: "BLOCK_ME" } : {}),
          },
          "event %s carries token=SECRET_TOKEN_%s",
          id,
          `${index}`,
        );
        emitted += 1;
        await yieldToLoop();
      }
    }),
  );
  return emitted;
}

function assertNoCrossEventLeak(lines: Line[], emitted: number): void {
  expect(lines).toHaveLength(emitted);
  const ids = new Set<string>();
  for (const line of lines) {
    const id = line.id as string;
    ids.add(id);
    const [task, index] = id.split("-").map(Number) as [number, number];
    expect(line.msg).toBe(`event ${id} carries token=<SECRET_1>`);
    expect(line.detail).toEqual({ note: `event ${id} key <SECRET_1>`, tags: [`tag ${id}`, "<SECRET_1>"] });
    expect(line.task).toBe(`task-${task} <SECRET_1>`);
    // A block decision belongs to its own event only.
    const blocked = (task * EVENTS_PER_TASK + index) % 7 === 0;
    expect(line.blocked).toBe(blocked ? "[REDACTED:BLOCKED]" : undefined);
  }
  expect(ids.size).toBe(emitted);
}

function parseLines(text: string): Line[] {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Line);
}

test("interleaved async loggers share one hook without cross-event plaintext or state leakage", async () => {
  const chunks: string[] = [];
  const logger = pino(
    { base: null, timestamp: false, hooks: hooks() },
    {
      write(chunk: string) {
        chunks.push(chunk);
      },
    },
  );
  const emitted = await logConcurrently(logger);
  const raw = chunks.join("");
  expect(raw).not.toMatch(/SECRET_TOKEN_\d|BLOCK_ME/);
  assertNoCrossEventLeak(parseLines(raw), emitted);
});

test("a walk budget spent by one event never carries over to the next", () => {
  const chunks: string[] = [];
  const logMethod = createRedactingLogMethodWith(fakeScanAndRedact, { limits: { maxTotalLeaves: 3 } });
  const logger = pino(
    { base: null, timestamp: false, hooks: { logMethod } },
    {
      write(chunk: string) {
        chunks.push(chunk);
      },
    },
  );
  logger.info({ a: "1", b: "2", c: "3", d: "SECRET_TOKEN_1" }, "wide");
  logger.info({ a: "SECRET_TOKEN_2" }, "narrow");
  const [wide, narrow] = parseLines(chunks.join("")) as Record<string, unknown>[];
  expect(wide).toMatchObject({ d: "[REDACTED:LIMIT_EXCEEDED]", msg: "[REDACTED:LIMIT_EXCEEDED]" });
  expect(narrow).toMatchObject({ a: "<SECRET_1>", msg: "narrow" });
  expect(chunks.join("")).not.toMatch(/SECRET_TOKEN_\d/);
});

test("pino's buffered asynchronous destination (sonic-boom) only ever receives redacted bytes", async () => {
  const file = scratchFile("async.log");
  const destination = pino.destination({ dest: file, sync: false, minLength: 4096 });
  const logger = pino({ base: null, timestamp: false, hooks: hooks() }, destination);
  const emitted = await logConcurrently(logger);
  await new Promise<void>((resolve, reject) => {
    destination.once("close", resolve);
    destination.once("error", reject);
    destination.end();
  });
  const raw = readFileSync(file, "utf-8");
  expect(raw).not.toMatch(/SECRET_TOKEN_\d|BLOCK_ME/);
  assertNoCrossEventLeak(parseLines(raw), emitted);
});

test("pino's worker-thread transport, with its own buffering and backpressure, only ever receives redacted bytes", async () => {
  const file = scratchFile("transport.log");
  const transport = pino.transport({ target: "pino/file", options: { destination: file, mkdir: true } });
  const logger = pino({ base: null, timestamp: false, hooks: hooks() }, transport);
  const emitted = await logConcurrently(logger);
  await new Promise<void>((resolve, reject) => {
    transport.once("close", resolve);
    transport.once("error", reject);
    transport.end();
  });
  const raw = readFileSync(file, "utf-8");
  expect(raw).not.toMatch(/SECRET_TOKEN_\d|BLOCK_ME/);
  assertNoCrossEventLeak(parseLines(raw), emitted);
}, 20_000);

test("a destination that fails while echoing the chunk it was given surfaces only redacted text", () => {
  const logger = pino(
    { base: null, timestamp: false, hooks: hooks() },
    {
      write(chunk: string) {
        throw new Error(`disk full while writing ${chunk}`);
      },
    },
  );
  let caught: unknown;
  try {
    logger.info({ auth: "Bearer SECRET_TOKEN_1" }, "token %s", "SECRET_TOKEN_2");
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  const message = (caught as Error).message;
  expect(message).toContain("<SECRET_1>");
  expect(message).not.toMatch(/SECRET_TOKEN_\d/);
});

test("a destination reporting backpressure (write returning false) still only receives redacted bytes", () => {
  const chunks: string[] = [];
  const logger = pino(
    { base: null, timestamp: false, hooks: hooks() },
    {
      write(chunk: string) {
        chunks.push(chunk);
        return false;
      },
    },
  );
  for (let index = 0; index < 100; index += 1) logger.info("token %s", `SECRET_TOKEN_${index}`);
  expect(chunks).toHaveLength(100);
  expect(chunks.join("")).not.toMatch(/SECRET_TOKEN_\d/);
});
