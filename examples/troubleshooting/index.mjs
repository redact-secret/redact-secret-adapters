import {
  AI_CONTEXT_DEFAULT_LIMITS,
  createAiContextBoundary,
  createAiContextBoundaryWith,
} from "@redact-secret/adapter-ai-context";
import { createRedactingHooks } from "@redact-secret/adapter-pino";
import pino from "pino";
import { describeOutcome } from "./messages.mjs";

const boundary = await createAiContextBoundary();
const results = [];

function check(name, outcome, expected) {
  const { internal } = describeOutcome(outcome);
  const actual = outcome.outcome === "blocked" ? `blocked/${outcome.reason}` : outcome.outcome;
  const ok = actual === expected;
  results.push(ok);
  console.log(`${ok ? "ok  " : "FAIL"} ${name.padEnd(34)} ${actual.padEnd(26)} ${ok ? internal : "(unexpected)"}`);
}

// 1. A value that is not JSON-shaped is refused, never converted for you.
// snippet:start unsupported
check("Date value", boundary.sanitizeValue({ when: new Date(0) }), "blocked/unsupported_value");
// Fix: convert deliberately, so what is scanned is exactly what you send. Omit `undefined` fields.
check("Date as ISO string", boundary.sanitizeValue({ when: new Date(0).toISOString() }), "ok");
// snippet:end unsupported

// 2. A limit is exceeded. Nothing is truncated and nothing passes through.
// snippet:start limits
const tight = await createAiContextBoundary({
  wholeInputLimits: { maxInputBytes: 16, maxFindings: 8 }, // a COMPLETE set; see the next case
});
check("Input over maxInputBytes", tight.sanitizeText("x".repeat(100)), "blocked/limit_exceeded");
// Fix: send less (split the input, drop what the model does not need). If the default really is too
// small, replace the WHOLE set, starting from the defaults:
const roomier = await createAiContextBoundary({
  wholeInputLimits: { ...AI_CONTEXT_DEFAULT_LIMITS.wholeInputLimits, maxInputBytes: 131072 },
});
check("Same input, a roomier limit", roomier.sanitizeText("x".repeat(100)), "ok");
// snippet:end limits

// 3. A partial limit set is not merged with the defaults: it is an invalid set.
// snippet:start partial
const partial = await createAiContextBoundary({ wholeInputLimits: { maxInputBytes: 1024 } });
check("Partial limit set", partial.sanitizeText("hello"), "blocked/core_error");
// snippet:end partial

// 3b. Text the core cannot read (a lone surrogate) is a core error with a fixed code.
// snippet:start surrogate
const lone = "a\ud800b";
check("Lone surrogate", boundary.sanitizeText(lone), "blocked/core_error");
// Fix: make the text well formed before scanning. The replacement character is what is scanned and sent.
check("Well-formed text", boundary.sanitizeText(lone.toWellFormed()), "ok");
// snippet:end surrogate

// 4. A stream releases nothing before finalize, and a failed stream says so through `accepting`.
// snippet:start stream
const stream = boundary.openStream({ boundary: "user-input" });
const chunks = ["ok ", "x".repeat(1_048_577), "never read"];
let read = 0;
for (const chunk of chunks) {
  stream.append(chunk);
  read += 1;
  if (!stream.accepting) break; // stop pulling from the producer: later chunks would be discarded
}
const streamed = stream.finalize(); // the reason arrives here, and only here
// snippet:end stream
check("Stream over its input limit", streamed, "blocked/limit_exceeded");
results.push(read === 2);
console.log(
  `${read === 2 ? "ok  " : "FAIL"} ${"Stopped reading at the failure".padEnd(34)} ${read} of ${chunks.length} chunks read`,
);

// 5. A stream is single use.
// snippet:start single-use
const once = boundary.openStream({ boundary: "user-input" });
once.append("hello");
check("First finalize", once.finalize(), "ok");
check("Second finalize", once.finalize(), "blocked/lifecycle"); // open a new stream instead
// snippet:end single-use

// 6. A cancelled operation is `aborted`: no value, and not a failure to retry blindly.
// snippet:start abort
const controller = new AbortController();
controller.abort();
check("Already-aborted signal", boundary.sanitizeText("hello", { signal: controller.signal }), "aborted");
// snippet:end abort

// 7. A core failure never forwards the error's message.
// snippet:start core-error
const failing = {
  scanAndRedact() {
    throw new Error("a message that must never be forwarded");
  },
  createIncrementalSanitizer() {
    throw new Error("unused");
  },
};
const broken = createAiContextBoundaryWith(failing, AI_CONTEXT_DEFAULT_LIMITS);
const coreFailure = broken.sanitizeText("hello");
check("Core throws", coreFailure, "blocked/core_error");
// The outcome holds a fixed reason and no message. Treat it as a failure, never as ok.
// snippet:end core-error
const leaked = JSON.stringify(coreFailure).includes("must never be forwarded");
results.push(!leaked);
console.log(
  `${leaked ? "FAIL" : "ok  "} ${"Error message is suppressed".padEnd(34)} ${leaked ? "(message found)" : "not in the outcome"}`,
);

// 8. A logging marker. A value past a walk limit is replaced, never scanned and never passed on.
function captureLogger(hooks) {
  let text = "";
  const sink = {
    write(line) {
      text += line;
    },
  };
  return { logger: pino({ base: null, timestamp: false, hooks }, sink), text: () => text };
}
// snippet:start marker
const small = captureLogger(await createRedactingHooks({ limits: { maxStringLength: 20 } }));
small.logger.info({ payload: "x".repeat(50) }, "received");
// Fix: do not log the whole payload. Log what you need to diagnose, which is bounded by nature.
small.logger.info({ payloadLength: 50 }, "received");
// snippet:end marker
const lines = small.text().trim().split("\n");
const markerOk = lines[0].includes("[REDACTED:LIMIT_EXCEEDED]") && !lines[1].includes("REDACTED");
results.push(markerOk);
console.log(`${markerOk ? "ok  " : "FAIL"} ${"pino: over maxStringLength".padEnd(34)} marker, then a bounded field`);

// 9. Unknown outcomes get generic, safe guidance.
const unknown = describeOutcome({ outcome: "blocked", reason: "something_new", code: "x <script>" });
results.push(unknown.internal.startsWith("Unrecognised") && !unknown.internal.includes("script"));
console.log(`${results.at(-1) ? "ok  " : "FAIL"} ${"Unknown reason".padEnd(34)} ${unknown.user}`);

if (results.some((ok) => !ok)) {
  console.error("FAIL: an outcome did not match its documented cause");
  process.exit(1);
}
console.log("OK: every outcome matched its documented cause and correction");
