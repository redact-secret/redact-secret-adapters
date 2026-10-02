/**
 * Shared fixtures for the pino scenarios (#194). Not a scenario module (the leading
 * underscore keeps it out of discovery). Everything here is synthetic.
 *
 * The verifier looks only at the bytes a destination received, never at how the
 * pipeline was built or at onOutcome (the same rule as examples/placement-js/verify.mjs).
 */

import { spawnSync } from "node:child_process";
import * as adapterPino from "@redact-secret/adapter-pino";
import pino from "pino";

// Synthetic, revoked-shaped values only (see contract/sentinels.d/*.json).
export const TOKEN = "ghp_SYNTHETICREVOKED00000000000000000000";
export const EMAIL = "jane.doe@acme-corp.io";
export const WARN_VALUE = "hunter2hunter2";
export const SAMPLE = `token ${TOKEN}; customer email: ${EMAIL}; password=${WARN_VALUE}`;
const PEM_BODY = "MIIBOgIBAAJBAKSYNTHETICREVOKEDNOTAREALKEY".padEnd(76, "A");
export const PEM = [
  "-----BEGIN RSA PRIVATE KEY-----",
  PEM_BODY,
  PEM_BODY,
  PEM_BODY,
  "-----END RSA PRIVATE KEY-----",
].join("\n");
const SECRETS = [TOKEN, EMAIL, WARN_VALUE, "SYNTHETICREVOKEDNOTAREALKEY"];

export const BLOCK_MARKER = "[REDACTED:BLOCKED]";
export const ERROR_MARKER = "[REDACTED:ERROR]";
export const LIMIT_MARKER = "[REDACTED:LIMIT_EXCEEDED]";
const PLACEHOLDER = /<SECRET_\d+>|\[REDACTED:[A-Z_]+\]/;

/** A destination that keeps the exact bytes pino writes, bounded in size. */
export class Sink {
  constructor(maxBytes = 64 * 1024) {
    this.maxBytes = maxBytes;
    this.text = "";
    this.dropped = 0;
  }

  write(line) {
    if (this.text.length + line.length > this.maxBytes) {
      this.dropped += 1;
      return;
    }
    this.text += line;
  }

  lines() {
    return this.text.split("\n").filter(Boolean);
  }
}

/**
 * LEAKED     a fixture secret is in the captured output
 * UNVERIFIED nothing was captured, or no sanitized marker is in it, so nothing was proven
 * PROTECTED  output exists, no secret is in it, and a sanitized marker is present
 */
export function verdict(captured, secrets = SECRETS) {
  if (secrets.some((s) => captured.includes(s))) return "LEAKED";
  if (captured.length === 0 || !PLACEHOLDER.test(captured)) return "UNVERIFIED";
  return "PROTECTED";
}

/** Every line must be a JSON object: the host shape stays intact. */
export function parseLines(sink) {
  try {
    return sink.lines().map((l) => {
      const o = JSON.parse(l);
      if (o === null || typeof o !== "object" || Array.isArray(o)) throw new Error("not an object");
      return o;
    });
  } catch {
    return null;
  }
}

/** Stores the final destination bytes in the bounded capture sink, with fixture secrets masked. */
export function keep(ctx, label, text) {
  let safe = text;
  for (const s of SECRETS) safe = safe.split(s).join("[SENTINEL]");
  ctx.captures.add(label, safe);
}

export function logger(sink, hooks, extra = {}) {
  return pino({ base: null, timestamp: false, ...extra, ...(hooks ? { hooks } : {}) }, sink);
}

/** The same calls for every placement recipe: message, child binding, mixin output, structured value, Error. */
export function logEverywhere(log) {
  log.child({ session: TOKEN }).info({ req: { auth: `Bearer ${TOKEN}` } }, "deploy with token %s", TOKEN);
  log.error(new Error(`failed with ${TOKEN}`));
}

export const MIXIN = { mixin: () => ({ tenant: TOKEN }) };

/**
 * Which installed behaviors exist. Probed from the installed package, never inferred from a
 * version string: candidate mode includes the unreleased budget (#173), line ceilings (#174) and
 * key-aware detection (#172); the published pins do not.
 */
export async function features() {
  const budget = typeof adapterPino.PINO_LIMIT_LINE === "string" && adapterPino.DEFAULT_LINE_LIMITS !== undefined;
  let keyAware = false;
  try {
    const sink = new Sink();
    const log = logger(sink, await adapterPino.createRedactingHooks());
    log.info({ api_key: `${WARN_VALUE}xx` }, "k");
    keyAware = !sink.text.includes(WARN_VALUE);
  } catch {
    keyAware = false;
  }
  return { budget, keyAware };
}

/**
 * Gate for a lane that only the candidate supports. Candidate mode REQUIRES it (a missing
 * feature is a failed check); a published pin records an explicit "unsupported" instead of
 * silently passing. Returns true when the scenario may go on.
 */
export function requireFeature(ctx, rec, name, present, reason) {
  rec.evidence.mode = ctx.install.mode;
  rec.evidence[name] = present;
  if (present) return true;
  if (ctx.install.mode === "candidate") {
    rec.check(`candidate supports ${name}`, false, "feature missing from the candidate build");
  } else {
    rec.unsupported(reason);
  }
  return false;
}

/** Runs one PII profile in its own process (activation is process-wide and one-shot). */
export function runProfile(name, scriptUrl) {
  const child = spawnSync(process.execPath, [new URL(scriptUrl).pathname, name], {
    encoding: "utf-8",
    timeout: 15000,
    maxBuffer: 256 * 1024,
    env: { PATH: process.env.PATH ?? "" },
  });
  if (child.status !== 0) return null;
  try {
    return JSON.parse(child.stdout);
  } catch {
    return null;
  }
}
