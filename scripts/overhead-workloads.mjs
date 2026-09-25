/**
 * Builds the adapter-overhead workloads in `fixtures/overhead-profiles.json`
 * (#11). `scripts/measure-overhead.py` builds the same events from the same
 * parameters; `scripts/check-overhead-workloads.mjs` and
 * `python/tests/test_overhead_workloads.py` pin both to one digest, so a
 * JavaScript and a Python number for the same profile describe the same
 * input.
 *
 * Every string is filler from the profile file or one synthetic token built
 * here at runtime. Nothing is read from the environment.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const PROFILES_URL = new URL("../fixtures/overhead-profiles.json", import.meta.url);

export function loadProfiles() {
  return JSON.parse(readFileSync(PROFILES_URL, "utf-8"));
}

export function syntheticSecret(document) {
  const { prefix, fill, length } = document.secret;
  return `${prefix}${fill.repeat(length)}`;
}

function wordsFor(document, count, seed) {
  const { filler } = document;
  const out = [];
  for (let k = 0; k < count; k += 1) out.push(filler[(seed + k * 7) % filler.length]);
  return `${out.join(" ")} #${seed}`;
}

function nested(document, depth, seed, words) {
  let value = { leaf: wordsFor(document, words, seed) };
  for (let level = 1; level < depth; level += 1)
    value = { level: wordsFor(document, words, seed + level), inner: value };
  return value;
}

function logEvent(document, params, index, secret) {
  const message = `${wordsFor(document, params.stringWords, index)}${" %s".repeat(params.messageArgs)}`;
  const args = Array.from({ length: params.messageArgs }, (_, a) => `v${index}-${a}`);
  const fields = {};
  for (let f = 0; f < params.fields; f += 1) fields[`f${f}`] = wordsFor(document, params.stringWords, index + f);
  if (params.nestedDepth > 0) fields.f0 = nested(document, params.nestedDepth, index, params.stringWords);
  if (params.arrayLength > 0) {
    fields.f1 = Array.from({ length: params.arrayLength }, (_, a) => wordsFor(document, params.stringWords, index + a));
  }
  if (secret !== undefined) fields.f2 = `token=${secret}`;
  return { message, args, fields };
}

function spanEvent(document, params, index, secret) {
  const attributes = {};
  for (let a = 0; a < params.attributes; a += 1)
    attributes[`a${a}`] = wordsFor(document, params.stringWords, index + a);
  for (let a = 0; a < params.arrayAttributes; a += 1) {
    attributes[`arr${a}`] = Array.from({ length: params.arrayLength }, (_, k) =>
      wordsFor(document, params.stringWords, index + a + k),
    );
  }
  if (secret !== undefined) attributes.a2 = `token=${secret}`;
  const events = Array.from({ length: params.events }, (_, e) => {
    const eventAttributes = {};
    for (let a = 0; a < params.eventAttributes; a += 1) {
      eventAttributes[`e${a}`] = wordsFor(document, params.stringWords, index + e + a);
    }
    return { name: `event ${e} #${index}`, attributes: eventAttributes };
  });
  return { name: `op #${index}`, attributes, events };
}

function payloadEvent(document, params, index, secret) {
  const messages = Array.from({ length: params.messages }, (_, m) => ({
    role: m % 2 === 0 ? "user" : "assistant",
    content: wordsFor(document, params.stringWords, index + m),
  }));
  if (secret !== undefined) messages[1].content = `${messages[1].content} token=${secret}`;
  const toolCalls = Array.from({ length: params.toolCalls }, (_, t) => ({
    name: `tool_${t}`,
    arguments: { query: wordsFor(document, params.stringWords, index + t) },
    result: wordsFor(document, params.stringWords, index + t + 1),
  }));
  return { messages, toolCalls };
}

const BUILDERS = { "log-event": logEvent, span: spanEvent, payload: payloadEvent };

/** The profile's `distinctEvents` events, in order. */
export function buildEvents(document, profile) {
  const build = BUILDERS[profile.shape];
  if (build === undefined) throw new Error(`unknown workload shape: ${profile.shape}`);
  const secret = syntheticSecret(document);
  return Array.from({ length: document.distinctEvents }, (_, index) =>
    build(document, profile.params, index, index % profile.params.secretEvery === 0 ? secret : undefined),
  );
}

/** Canonical JSON (sorted keys) of every profile's events, hashed; identical in Python. */
export function workloadDigest(document) {
  const canonical = (value) => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object") {
      return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
        .join(",")}}`;
    }
    return JSON.stringify(value);
  };
  const all = Object.fromEntries(document.profiles.map((profile) => [profile.id, buildEvents(document, profile)]));
  return createHash("sha256").update(canonical(all)).digest("hex");
}
