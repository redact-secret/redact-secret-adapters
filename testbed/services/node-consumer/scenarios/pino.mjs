/**
 * Pino qualification through the final destination bytes (#194, epic #190).
 *
 * Every assertion reads what the destination received. onOutcome counts are used only as a
 * secondary fact, never as the reason a scenario passes. Placement recipes follow
 * examples/placement-js (#183), configurations follow examples/policy-js (#181).
 *
 * Candidate mode includes the unreleased record budget, line ceilings and key-aware detection;
 * the published pins do not. Those lanes call requireFeature(): required (a failed check) in
 * candidate mode, an explicit "unsupported" result in published mode.
 */

import { createRedactingHooks, createRedactingHooksWith } from "@redact-secret/adapter-pino";
import { BoundedCaptures, MAX_ENTRIES, MAX_ENTRY_BYTES } from "../lib/captures.mjs";
import {
  BLOCK_MARKER,
  EMAIL,
  ERROR_MARKER,
  features,
  keep,
  LIMIT_MARKER,
  logEverywhere,
  logger,
  MIXIN,
  PASSWORD,
  PEM,
  parseLines,
  requireFeature,
  runProfile,
  Sink,
  TOKEN,
  verdict,
} from "./_pino-lib.mjs";

const PROFILE = import.meta.resolve("./_pino-profile.mjs");

async function paired(options = {}, extra = {}) {
  const sink = new Sink();
  const counts = [];
  const hooks = await createRedactingHooks({ ...options, onOutcome: (o) => counts.push(o) });
  return { sink, counts, log: logger(sink, hooks, extra) };
}

const hasNone = (text, ...values) => values.every((v) => !text.includes(v));

export const scenarios = [
  {
    id: "pino.paired-hooks-final-bytes",
    title:
      "createRedactingHooks: message, child binding, mixin, structured value and Error are clean in the destination bytes",
    classification: "qualification",
    async run(ctx, rec) {
      const { sink, counts, log } = await paired({}, MIXIN);
      logEverywhere(log);
      keep(ctx, "pino.paired-hooks-final-bytes", sink.text);
      const lines = parseLines(sink);
      rec.check("destination received output", sink.text.length > 0);
      rec.check("every line is a JSON object", lines !== null && lines.length === 2);
      rec.check("verdict is PROTECTED", verdict(sink.text) === "PROTECTED");
      rec.check("no fixture secret in the bytes", hasNone(sink.text, TOKEN));
      const [info, error] = lines ?? [{}, {}];
      rec.check(
        "child binding field kept and masked",
        typeof info.session === "string" && !info.session.includes("ghp_"),
      );
      rec.check("mixin field kept and masked", typeof info.tenant === "string" && !info.tenant.includes("ghp_"));
      rec.check("structured value keeps its shape", typeof info.req === "object" && typeof info.req?.auth === "string");
      rec.check(
        "message interpolation masked",
        typeof info.msg === "string" && info.msg.startsWith("deploy with token "),
      );
      rec.check(
        "Error keeps its serialized shape",
        typeof error.err === "object" && typeof error.err?.message === "string" && typeof error.err?.stack === "string",
      );
      rec.check("pino level fields kept", info.level === 30 && error.level === 50);
      rec.evidence.records = counts.length;
      rec.evidence.verdict = verdict(sink.text);
    },
  },
  {
    id: "pino.structured-and-serializers",
    title: "Custom serializers, formatters and a nested object: their output is clean in the destination bytes",
    classification: "qualification",
    async run(ctx, rec) {
      const extra = {
        ...MIXIN,
        serializers: { req: (r) => ({ url: r.url, authorization: `Bearer ${TOKEN}` }) },
        formatters: { log: (o) => ({ ...o, formatted: TOKEN }) },
      };
      const { sink, log } = await paired({}, extra);
      log.info({ req: { url: "/deploy" }, nested: { a: [{ b: TOKEN }] } }, "serialized");
      keep(ctx, "pino.structured-and-serializers", sink.text);
      const [line] = parseLines(sink) ?? [{}];
      rec.check("verdict is PROTECTED", verdict(sink.text) === "PROTECTED");
      rec.check("serializer output masked", typeof line.req?.authorization === "string" && !sink.text.includes(TOKEN));
      rec.check("serializer keeps the field shape", line.req?.url === "/deploy");
      rec.check("formatter output masked", typeof line.formatted === "string" && !line.formatted.includes("ghp_"));
      rec.check("nested array element masked", typeof line.nested?.a?.[0]?.b === "string");
      rec.check("message kept", line.msg === "serialized");
    },
  },
  {
    id: "pino.host-hooks-composed",
    title:
      "Host logMethod and streamWrite hooks compose: what they add is masked too, and a throwing host hook leaks nothing",
    classification: "qualification",
    async run(ctx, rec) {
      const hostHooks = {
        logMethod(args, method) {
          method.apply(this, [{ added: TOKEN }, ...args]); // the host rewrites the call
        },
        streamWrite: (line) => line.replace(/}\n$/, `,"hostField":"${TOKEN}"}\n`),
      };
      const composed = await paired({ hooks: hostHooks });
      composed.log.info("host composed");
      keep(ctx, "pino.host-hooks-composed", composed.sink.text);
      const [line] = parseLines(composed.sink) ?? [{}];
      rec.check("verdict is PROTECTED", verdict(composed.sink.text) === "PROTECTED");
      rec.check("logMethod-added argument masked", typeof line.added === "string" && !line.added.includes("ghp_"));
      rec.check(
        "streamWrite-added field masked",
        typeof line.hostField === "string" && !line.hostField.includes("ghp_"),
      );

      const throwing = await paired({
        hooks: {
          streamWrite: () => {
            throw new Error("host hook failed");
          },
        },
      });
      throwing.log.info(`deploy ${TOKEN}`);
      rec.check("a throwing host hook still yields masked output", hasNone(throwing.sink.text, TOKEN));
      rec.check("a throwing host hook still yields a line", throwing.sink.text.length > 0);
    },
  },
  {
    id: "pino.negative-controls",
    title:
      "Unprotected and half-protected pino loggers are reported LEAKED; the verifier also reports UNVERIFIED for empty output",
    classification: "negative-control",
    async run(ctx, rec) {
      // Control 1: the logger nobody wrapped.
      const bare = new Sink();
      logEverywhere(logger(bare, null, MIXIN));
      keep(ctx, "pino.negative-controls.no-hooks", bare.text);
      rec.check("no hooks: verifier reports LEAKED", verdict(bare.text) === "LEAKED");

      // Control 2: only the call-argument hook. Child bindings and mixin output escape it.
      const { createRedactingLogMethod } = await import("@redact-secret/adapter-pino");
      const half = new Sink();
      logEverywhere(logger(half, { logMethod: await createRedactingLogMethod() }, MIXIN));
      keep(ctx, "pino.negative-controls.logmethod-only", half.text);
      const [info] = parseLines(half) ?? [{}];
      rec.check("logMethod only: verifier reports LEAKED", verdict(half.text) === "LEAKED");
      rec.check("logMethod only: the message itself was masked", !String(info.msg).includes(TOKEN));
      rec.check("logMethod only: the child binding escaped", String(info.session).includes(TOKEN));
      rec.check("logMethod only: the mixin output escaped", String(info.tenant).includes(TOKEN));

      // Control 3: a pipeline that drops everything proves nothing.
      rec.check("empty output is UNVERIFIED, not PROTECTED", verdict("") === "UNVERIFIED");
      rec.check("output with no marker is UNVERIFIED", verdict('{"msg":"hello"}\n') === "UNVERIFIED");

      // Control 4: the verifier itself: a protected logger passes it, so it can tell them apart.
      const ok = await paired({}, MIXIN);
      logEverywhere(ok.log);
      rec.check("protected logger is PROTECTED under the same verifier", verdict(ok.sink.text) === "PROTECTED");
    },
  },
  {
    id: "pino.policy-warn",
    title: "Default policy: a warn finding (password-shaped value) stays plaintext in the destination, and is counted",
    classification: "negative-control",
    async run(ctx, rec) {
      const { sink, counts, log } = await paired();
      log.info(`password=${PASSWORD}`);
      keep(ctx, "pino.policy-warn", sink.text);
      rec.check("the warn value is in the bytes (expected, documented)", sink.text.includes(PASSWORD));
      rec.compare(
        "warn value in the destination",
        "unchanged (warn)",
        sink.text.includes(PASSWORD) ? "unchanged (warn)" : "changed",
        "warn",
      );
      rec.check("verifier reports it as LEAKED, expected for a warn", verdict(sink.text, [PASSWORD]) === "LEAKED");
      rec.check(
        "nothing blocked or failed",
        counts.every((o) => o.values.blocked === 0 && o.values.failed === 0),
      );
      rec.check(
        "the finding was reported",
        counts.some((o) => o.values.findings > 0 && o.values.redacted === 0),
      );
      rec.evidence.expectation = "warn leaves text unchanged";
    },
  },
  {
    id: "pino.policy-block",
    title: "A private-key block is replaced whole by the fixed BLOCKED marker; the line shape is kept",
    classification: "qualification",
    async run(ctx, rec) {
      const { sink, counts, log } = await paired();
      log.info("key %s", PEM);
      log.info({ pem: PEM }, "structured");
      keep(ctx, "pino.policy-block", sink.text);
      const lines = parseLines(sink);
      rec.check("every line is a JSON object", lines !== null && lines.length === 2);
      rec.check(
        "key material absent",
        !sink.text.includes("SYNTHETICREVOKEDNOTAREALKEY") && !sink.text.includes("BEGIN RSA"),
      );
      rec.check("fixed BLOCKED marker present", sink.text.includes(BLOCK_MARKER));
      rec.check("structured field replaced by the marker", lines?.[1]?.pem === BLOCK_MARKER);
      rec.compare("structured private-key field", BLOCK_MARKER, lines?.[1]?.pem, "block");
      rec.check(
        "blocked values were counted",
        counts.some((o) => o.values.blocked > 0),
      );
    },
  },
  {
    id: "pino.policy-explicit",
    title: "An explicit policy mapping every finding to redact masks the warn value in the destination",
    classification: "qualification",
    async run(ctx, rec) {
      const policy = { evaluate: (f) => (f.type === "private_key" ? "block" : "redact") };
      const sink = new Sink();
      const log = logger(sink, await createRedactingHooks({ policy }));
      log.info(`password=${PASSWORD}`);
      log.info("key %s", PEM);
      keep(ctx, "pino.policy-explicit", sink.text);
      rec.check("the former warn value is masked", !sink.text.includes(PASSWORD));
      rec.compare(
        "former warn value under an explicit policy",
        "masked",
        sink.text.includes(PASSWORD) ? "plaintext" : "masked",
        "policy",
      );
      rec.check("verdict is PROTECTED", verdict(sink.text) === "PROTECTED");
      rec.check("block is still honoured under the explicit policy", sink.text.includes(BLOCK_MARKER));
    },
  },
  {
    id: "pino.limits-walk",
    title: "Per-value walk limit: an oversized value is replaced by the fixed LIMIT marker, never passed through",
    classification: "qualification",
    async run(ctx, rec) {
      const { sink, counts, log } = await paired({ limits: { maxStringLength: 40 } }, MIXIN);
      log.info({ big: `${"y".repeat(80)}${TOKEN}` }, `short ${TOKEN}`);
      keep(ctx, "pino.limits-walk", sink.text);
      const [line] = parseLines(sink) ?? [{}];
      rec.check("the line is still a JSON object", line !== undefined && typeof line === "object");
      rec.check("oversized value replaced by the LIMIT marker", line.big === LIMIT_MARKER);
      rec.check("no plaintext fallback", !sink.text.includes(TOKEN) && !sink.text.includes("yyyy"));
      rec.check(
        "limited values were counted",
        counts.some((o) => o.values.limited > 0),
      );
    },
  },
  {
    id: "pino.limits-record-budget",
    title: "Per-record aggregate budget (candidate): an exhausted budget yields the fixed LIMIT line, never plaintext",
    classification: "qualification",
    async run(ctx, rec) {
      const f = await features();
      if (
        !requireFeature(
          ctx,
          rec,
          "record-budget",
          f.budget,
          "the installed adapter-pino has no per-record budget (#173)",
        )
      )
        return;
      const { sink, counts, log } = await paired({ operationLimits: { maxScans: 1 } }, MIXIN);
      log.child({ a: TOKEN, b: TOKEN }).info({ x: TOKEN, y: TOKEN }, `m ${TOKEN}`);
      keep(ctx, "pino.limits-record-budget", sink.text);
      const lines = parseLines(sink);
      rec.check("one JSON line written", lines !== null && lines.length === 1);
      rec.check("no plaintext fallback", !sink.text.includes(TOKEN));
      rec.check("fixed LIMIT marker present", sink.text.includes(LIMIT_MARKER));
      rec.check(
        "record reported as limited, line replaced",
        counts.some((o) => o.values.limited > 0 && o.lineReplaced === true),
      );
      // A fresh record gets a fresh budget.
      const again = await paired({ operationLimits: { maxScans: 1000 } });
      again.log.info(`deploy ${TOKEN}`);
      rec.check("a record within budget is masked normally", verdict(again.sink.text) === "PROTECTED");
    },
  },
  {
    id: "pino.limits-line-ceiling",
    title: "Line ceiling (candidate): an over-long line becomes the fixed valid LIMIT line, never the original",
    classification: "qualification",
    async run(ctx, rec) {
      const f = await features();
      if (
        !requireFeature(
          ctx,
          rec,
          "line-ceiling",
          f.budget,
          "the installed adapter-pino has no streamWrite line ceilings (#174)",
        )
      )
        return;
      const { sink, counts, log } = await paired({ lineLimits: { maxLineLength: 64 } });
      log.info(`${"x ".repeat(40)}${TOKEN}`);
      keep(ctx, "pino.limits-line-ceiling", sink.text);
      const lines = parseLines(sink);
      rec.check("exactly one valid JSON line", lines !== null && lines.length === 1);
      rec.check(
        "the line is the fixed LIMIT line",
        lines?.[0]?.msg === LIMIT_MARKER && Object.keys(lines[0]).length === 1,
      );
      rec.check("the original line is not in the bytes", !sink.text.includes(TOKEN) && !sink.text.includes("x x x"));
      rec.check(
        "reported as a replaced line",
        counts.some((o) => o.lineReplaced === true && o.values.limited > 0),
      );
    },
  },
  {
    id: "pino.key-aware",
    title:
      "Key-aware detection (candidate): a context-dependent value under a credential key is masked in bindings, mixin and arguments",
    classification: "qualification",
    async run(ctx, rec) {
      const f = await features();
      if (
        !requireFeature(
          ctx,
          rec,
          "key-aware",
          f.keyAware,
          "the installed adapter-pino gives string values no key context (#172)",
        )
      )
        return;
      const sink = new Sink();
      logger(sink, await createRedactingHooks(), { mixin: () => ({ client_secret: `${PASSWORD}mx` }) })
        .child({ api_key: `${PASSWORD}mx` })
        .info({ password: `${PASSWORD}xx` }, "keyed");
      keep(ctx, "pino.key-aware", sink.text);
      rec.check("no keyed value in the bytes", !sink.text.includes(PASSWORD));
      const [line] = parseLines(sink) ?? [{}];
      rec.check("keys are untouched", "api_key" in line && "client_secret" in line && "password" in line);
    },
  },
  {
    id: "pino.injected-scanner-failure",
    title: "FAULT INJECTION: a scanner that throws or returns garbage yields the fixed ERROR marker, never plaintext",
    classification: "failure-injection",
    async run(ctx, rec) {
      const faults = {
        throws: () => {
          throw new Error(`injected failure carrying ${TOKEN}`);
        },
        "returns no text": () => ({ text: null, findings: [] }),
        "returns nothing": () => undefined,
      };
      for (const [name, fake] of Object.entries(faults)) {
        const sink = new Sink();
        const counts = [];
        const hooks = createRedactingHooksWith(fake, { onOutcome: (o) => counts.push(o) });
        const log = logger(sink, hooks, MIXIN);
        log.child({ session: TOKEN }).info({ a: TOKEN }, `m ${TOKEN}`);
        log.error(new Error(`failed ${TOKEN}`));
        keep(ctx, `pino.injected-scanner-failure.${name}`, sink.text);
        const lines = parseLines(sink);
        rec.check(`${name}: no plaintext fallback`, !sink.text.includes(TOKEN));
        rec.check(
          `${name}: host line shape kept`,
          lines !== null && lines.length === 2 && lines.every((l) => "level" in l),
        );
        rec.check(`${name}: fixed ERROR marker used`, sink.text.includes(ERROR_MARKER));
        rec.check(`${name}: failures counted`, counts.length === 2 && counts.every((o) => o.values.failed > 0));
      }
    },
  },
  {
    id: "pino.invalid-line-fails-closed",
    title: "A line whose value literal cannot be decoded becomes the fixed ERROR line, not the original",
    classification: "qualification",
    async run(ctx, rec) {
      // Real core; the invalid line is produced by a host streamWrite hook (the documented contract
      // is valid JSON, so this is the misbehaving-host case).
      const bad = { streamWrite: () => `{"a":"\\q ${TOKEN}"}\n` };
      const { sink, counts, log } = await paired({ hooks: bad });
      log.info("x");
      keep(ctx, "pino.invalid-line-fails-closed", sink.text);
      const lines = parseLines(sink);
      rec.check("one valid JSON line", lines !== null && lines.length === 1);
      rec.check(
        "it is exactly the fixed ERROR line",
        lines?.[0]?.msg === ERROR_MARKER && Object.keys(lines[0]).length === 1,
      );
      rec.check("the original is not in the bytes", !sink.text.includes(TOKEN));
      rec.check(
        "reported as a failed, replaced line",
        counts.some((o) => o.lineReplaced === true && o.values.failed > 0),
      );
    },
  },
  {
    id: "pino.pii-default",
    title: "Own process, PII off: the credential is masked, the email and the warn value remain in the destination",
    classification: "negative-control",
    async run(ctx, rec) {
      const r = runProfile("default", PROFILE);
      rec.check("the isolated process finished", r !== null);
      if (!r) return;
      keep(ctx, "pino.pii-default", r.line);
      rec.check("credential masked", !r.line.includes(TOKEN));
      rec.check("PII stays (PII not activated)", r.line.includes(EMAIL));
      rec.check("warn value stays", r.line.includes(PASSWORD));
      rec.check("nothing blocked or failed", r.counts.blocked === 0 && r.counts.failed === 0);
      rec.evidence.findings = r.counts.findings;
    },
  },
  {
    id: "pino.pii-global",
    title: "Own process, pii:global activated: the email is masked, the warn value still remains",
    classification: "qualification",
    async run(ctx, rec) {
      const base = runProfile("default", PROFILE);
      const r = runProfile("pii", PROFILE);
      rec.check("the isolated processes finished", r !== null && base !== null);
      if (!r || !base) return;
      keep(ctx, "pino.pii-global", r.line);
      rec.check("credential masked", !r.line.includes(TOKEN));
      rec.check("high-confidence PII masked", !r.line.includes(EMAIL));
      rec.check("warn value still plaintext under the default policy", r.line.includes(PASSWORD));
      rec.check("one more finding than with PII off", r.counts.findings > base.counts.findings);
    },
  },
  {
    id: "pino.pii-explicit-policy",
    title: "Own process, pii:global with an explicit policy: every finding is masked",
    classification: "qualification",
    async run(ctx, rec) {
      const r = runProfile("policy", PROFILE);
      rec.check("the isolated process finished", r !== null);
      if (!r) return;
      keep(ctx, "pino.pii-explicit-policy", r.line);
      rec.check("verdict is PROTECTED", verdict(r.line) === "PROTECTED");
      rec.check("credential, email and warn value all masked", hasNone(r.line, TOKEN, EMAIL, PASSWORD));
      rec.check("nothing blocked or failed", r.counts.blocked === 0 && r.counts.failed === 0);
    },
  },
  {
    id: "pino.pii-conflict",
    title: "Own process: a conflicting second PII selection is rejected with a fixed code, not run with PII off",
    classification: "qualification",
    async run(_ctx, rec) {
      const r = runProfile("conflict", PROFILE);
      rec.check("the isolated process finished", r !== null);
      if (!r) return;
      rec.check("the conflicting selection rejected", r.rejected === true);
      rec.check("rejection carries a fixed code", typeof r.code === "string" && /^[A-Z_]+$/.test(r.code));
      rec.check("the message does not echo the selector", r.leaksSelector === false);
      rec.evidence.code = r.code;
    },
  },
  {
    id: "pino.bounded-capture",
    title:
      "Capture size is bounded: a flooded sink keeps whole lines under its cap, and the shared capture sink caps entries",
    classification: "qualification",
    async run(_ctx, rec) {
      const sink = new Sink(8 * 1024);
      const log = logger(sink, await createRedactingHooks());
      for (let i = 0; i < 400; i++) log.info({ i }, `flood ${TOKEN}`);
      rec.check("sink stayed under its byte cap", sink.text.length <= sink.maxBytes);
      rec.check("excess lines were dropped, not buffered", sink.dropped > 0);
      rec.check("every retained line is whole valid JSON", parseLines(sink) !== null);
      rec.check("retained output is clean", verdict(sink.text) === "PROTECTED");

      const captures = new BoundedCaptures();
      for (let i = 0; i < MAX_ENTRIES + 50; i++) captures.add(`flood-${i}`, "z".repeat(MAX_ENTRY_BYTES * 3));
      const snap = captures.snapshot();
      rec.check("capture sink caps the entry count", snap.length === MAX_ENTRIES);
      rec.check(
        "capture sink caps each entry",
        snap.every((e) => e.body.length <= MAX_ENTRY_BYTES),
      );
      rec.check("capture sink drops the oldest first", snap[0].label === "flood-50");
      rec.evidence.dropped = sink.dropped;
    },
  },
];
