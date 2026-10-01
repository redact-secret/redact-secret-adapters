import type { ScanAndRedact } from "@redact-secret/adapter";
import { createOutcomeCounter, ERROR_MARKER, LIMIT_MARKER } from "@redact-secret/adapter";
import type { LogFn, Logger } from "pino";
import { expect, test } from "vitest";

import { fakeScanAndRedact } from "../../../fixtures/fake-scanner.js";
import { createRedactingLogMethodWith, type RedactingLogMethod } from "../src/index.js";

/** Runs the hook the way pino's `genLog` does and returns what reached pino's own method. */
function run(
  hook: RedactingLogMethod,
  args: unknown[],
  receiver: object = {},
): { args: unknown[] | undefined; calls: number } {
  const seen: unknown[][] = [];
  const method = ((...received: unknown[]) => {
    seen.push(received);
  }) as LogFn;
  hook.call(receiver as Logger, args as Parameters<LogFn>, method, 30);
  return { args: seen[0], calls: seen.length };
}

const hook = createRedactingLogMethodWith(fakeScanAndRedact);

test("msgPrefix with an object-only call: the arguments reach pino unchanged, no prefixed undefined message", () => {
  const input = { a: 1 };
  const { args } = run(hook, [input], { msgPrefix: "[auth] " });
  expect(args).toEqual([{ a: 1 }]);
  expect(args).toHaveLength(1);
});

test("without msgPrefix a message starting with the word undefined is logged intact", () => {
  expect(run(hook, ["undefined value"]).args).toEqual(["undefined value"]);
  expect(run(hook, ["undefined value"], { msgPrefix: "" }).args).toEqual(["undefined value"]);
});

test("a redaction of the prefix and message as one match hands pino the whole marker, never a cut one", () => {
  const whole: ScanAndRedact = (text) =>
    text.includes("api_key=SECRET_TOKEN_7")
      ? { text: "<REDACTED_CREDENTIAL_ASSIGNMENT>", findings: fakeScanAndRedact("SECRET_TOKEN_7").findings }
      : { text, findings: [] };
  const { args } = run(createRedactingLogMethodWith(whole), ["SECRET_TOKEN_7"], { msgPrefix: "api_key=" });
  expect(args).toEqual(["<REDACTED_CREDENTIAL_ASSIGNMENT>"]);
});

test("a message that does not start with the prefix after redaction is left whole", () => {
  const shorter: ScanAndRedact = (text) => ({ text: text.replace("api_key=SECRET_TOKEN_7", "<X>"), findings: [] });
  const { args } = run(createRedactingLogMethodWith(shorter), ["SECRET_TOKEN_7"], { msgPrefix: "api_key=" });
  expect(args).toEqual(["<X>"]);
});

test("restoreErrors never touches a non-object first argument", () => {
  const err = new Error("db failed");
  // pino's own formatting drops the unused trailing Error.
  expect(run(hook, ["msg", err]).args).toEqual(["msg"]);

  expect(run(hook, [null, "msg"]).args).toEqual([null, "msg"]);
  expect(run(hook, [undefined, "msg"]).args).toEqual([undefined, "msg"]);
  expect(run(hook, [42, "extra"]).args).toEqual([42, "extra"]);
});

test("a merging object the walk replaces with a marker string stays that marker string", () => {
  const limited = createRedactingLogMethodWith(fakeScanAndRedact, { limits: { maxDepth: 1 } });
  const { args } = run(limited, [{ "0": new Error("SECRET_TOKEN_7"), "1": new Error("x") }, "msg"]);
  expect(args).toEqual([LIMIT_MARKER, "msg"]);
  expect(typeof args?.[0]).toBe("string");
});

test("a leading Error the walk replaces with a marker string logs the marker string", () => {
  const limited = createRedactingLogMethodWith(fakeScanAndRedact, { limits: { maxDepth: 1 } });
  expect(run(limited, [new Error("SECRET_TOKEN_7"), "msg"]).args).toEqual([LIMIT_MARKER, "msg"]);
});

test("an Error under a merging key that the walk replaces with a marker string logs the marker string", () => {
  const limited = createRedactingLogMethodWith(fakeScanAndRedact, { limits: { maxDepth: 2 } });
  const { args } = run(limited, [{ err: new Error("SECRET_TOKEN_7") }, "msg"]);
  expect(args).toEqual([{ err: LIMIT_MARKER }, "msg"]);
  expect(typeof ((args ?? [])[0] as { err: unknown }).err).toBe("string");
});

test("a merged key with no own descriptor on the original is logged normally", () => {
  const merging = {
    a: 1,
    toJSON() {
      return { a: 1, extra: "SECRET_TOKEN_7", err: "x" };
    },
  };
  const { args } = run(hook, [merging, "msg"]);
  expect(args).toEqual([{ a: 1, extra: "<SECRET_1>", err: "x" }, "msg"]);
});

test("a merged array value is still an array, not re-prototyped as an Error", () => {
  const { args } = run(hook, [{ list: ["a", "b"], nested: { k: "v" } }]);
  const merged = args?.[0] as { list: unknown; nested: unknown };
  expect(Array.isArray(merged.list)).toBe(true);
  expect(merged.list).toEqual(["a", "b"]);
  expect(JSON.stringify(args)).toBe('[{"list":["a","b"],"nested":{"k":"v"}}]');
  expect(merged.nested).not.toBeInstanceOf(Error);
});

test("a re-prototyped Error keeps plain enumerable, writable, configurable data properties", () => {
  const leading = run(hook, [new TypeError("boom SECRET_TOKEN_7")]).args?.[0] as object;
  expect(leading).toBeInstanceOf(TypeError);
  for (const key of Object.keys(leading)) {
    expect(Object.getOwnPropertyDescriptor(leading, key)).toEqual({
      value: (leading as Record<string, unknown>)[key],
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  expect(Object.keys(leading)).toContain("message");

  const [mergedArg] = run(hook, [{ err: new TypeError("x") }]).args ?? [];
  const nested = (mergedArg as { err: object }).err;
  expect(Object.getOwnPropertyDescriptor(mergedArg, "err")).toEqual({
    value: nested,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  expect(nested).toBeInstanceOf(TypeError);
  expect(Object.getOwnPropertyDescriptor(nested, "message")).toEqual({
    value: "x",
    enumerable: true,
    configurable: true,
    writable: true,
  });
});

test("a single message with no further arguments is not formatted", () => {
  expect(run(hook, ["100%% done"]).args).toEqual(["100%% done"]);
  expect(run(hook, ["100%% done", ""]).args).toEqual(["100% done"]);
});

test("a non-string message with extra arguments logs what pino logs", () => {
  expect(run(hook, [42, "extra"]).args).toEqual([42, "extra"]);
  expect(run(hook, [{ a: 1 }, 42, "extra %s"]).args).toEqual([{ a: 1 }, 42, "extra %s"]);
});

test("a message at the end of the arguments with an object first is not formatted either", () => {
  expect(run(hook, [{ a: 1 }, "100%% done"]).args).toEqual([{ a: 1 }, "100%% done"]);
});

test("a thrown formatting failure counts as failed and logs the error marker", () => {
  const counter = createOutcomeCounter();
  const counted = createRedactingLogMethodWith(fakeScanAndRedact, { counter });
  const { args, calls } = run(counted, ["%d", Symbol("x")]);
  expect(calls).toBe(1);
  expect(args).toEqual([ERROR_MARKER]);
  expect(counter.failed).toBe(1);
});

test("a scanner that returns a non-array walk result counts one failure", () => {
  const counter = createOutcomeCounter();
  const counted = createRedactingLogMethodWith(fakeScanAndRedact, { limits: { maxDepth: 0 }, counter });
  expect(run(counted, ["x"]).args).toEqual([ERROR_MARKER]);
  expect(counter.failed).toBe(1);
});

test("the constructor's TypeError names the function and the parameter", () => {
  expect(() => createRedactingLogMethodWith(null as unknown as ScanAndRedact)).toThrow(
    new TypeError("createRedactingLogMethodWith: scanAndRedact must be a function"),
  );
});
