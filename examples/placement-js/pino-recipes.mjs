import { createRedactingHooks, createRedactingLogMethod } from "@redact-secret/adapter-pino";
import pino from "pino";
import { TOKEN } from "./verify.mjs";

/** A destination that keeps the exact bytes pino writes. Swap it for the destination you actually use. */
function capture() {
  const sink = {
    text: "",
    write(line) {
      sink.text += line;
    },
  };
  return sink;
}

/** The same calls for every recipe: message, child binding, mixin output and an Error. */
function logEverywhere(logger) {
  logger.child({ session: TOKEN }).info({ req: { auth: `Bearer ${TOKEN}` } }, "deploy with token %s", TOKEN);
  logger.error(new Error(`failed with ${TOKEN}`));
}

const options = { base: null, timestamp: false, mixin: () => ({ tenant: TOKEN }) };

// snippet:start pino-protected
async function protectedPino() {
  const sink = capture();
  const logger = pino({ ...options, hooks: await createRedactingHooks() }, sink);
  logEverywhere(logger);
  return sink.text;
}
// snippet:end pino-protected

// Negative control 1: the logger you forgot to wrap. If the verifier cannot see this leak, it is broken.
async function unprotectedPino() {
  const sink = capture();
  logEverywhere(pino(options, sink));
  return sink.text;
}

// Negative control 2: only the call-argument hook. Child bindings and mixin output are added to the
// line later, so they are the part this placement leaves out.
async function logMethodOnlyPino() {
  const sink = capture();
  const logger = pino({ ...options, hooks: { logMethod: await createRedactingLogMethod() } }, sink);
  logEverywhere(logger);
  return sink.text;
}

export const pinoRecipes = [
  { label: "pino: message, child binding, mixin and Error, with createRedactingHooks()", capture: protectedPino },
  { label: "pino: no hooks at all", control: true, capture: unprotectedPino },
  {
    label: "pino: only the logMethod hook (child bindings and mixin escape)",
    control: true,
    capture: logMethodOnlyPino,
  },
];
