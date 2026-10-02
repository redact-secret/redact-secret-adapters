/**
 * AI-context server scenarios (#195): the INSTALLED `@redact-secret/adapter-ai-context`
 * over the real core, the way an application consumes it. These verify consumer
 * integration of the installed artifact; detection stays the core's business, and
 * nothing here is a detector oracle. Every assertion is on a final outcome or on
 * what a stub downstream recipient actually received.
 *
 * Version awareness: the candidate packs unreleased features (occurrence
 * provenance, operation budget, readiness check) that the pinned published
 * adapter does not have. Those are asserted only where installed, and reported
 * `unsupported` (never passed, never silently skipped) where not; in candidate
 * mode a missing feature is a failure.
 *
 * PII configurations run in their own child process (lib/aictx-child.mjs): PII
 * activation is process-wide and one-shot.
 */

import { execFile } from "node:child_process";
import { join } from "node:path";

const TOKEN = `ghp_SYNTHETICREVOKED${"0".repeat(20)}`;
const PEM = "-----BEGIN PRIVATE KEY-----\nU1lOVEhFVElDX1JFVk9LRURfQ09ORk9STUFOQ0U=\n-----END PRIVATE KEY-----";
const EMAIL = "jane.doe@acme-corp.io";
const KEYED = "synthetic-example-value-0001";
const WARN_ONLY = "password=hunter2hunter2";
const SENTINELS = [TOKEN, "U1lOVEhFVElDX1JFVk9LRURfQ09ORk9STUFOQ0U=", "BEGIN PRIVATE KEY", "hunter2hunter2"];
const OUTCOMES = ["ok", "blocked", "aborted"];
const SAFE_FINDING_FIELDS = ["action", "confidence", "detector", "end", "id", "obfuscation", "start", "type"];

const TINY = {
  wholeInputLimits: { maxInputBytes: 64, maxFindings: 4 },
  incrementalLimits: {
    maxInputCodeUnits: 4096,
    maxBufferedCodeUnits: 2176,
    maxTokenCodeUnits: 1024,
    maxMultilineCodeUnits: 2048,
  },
  traversalLimits: { maxDepth: 3, maxNodes: 6 },
};

const adapterMod = () => import("@redact-secret/adapter-ai-context");

/** The stub downstream recipient (a "model"): receives only what the application forwards. */
function makeDownstream(ctx, label) {
  const received = [];
  return {
    received,
    /** The only forwarding rule an application may follow: send `ok.value`, nothing else. */
    forward(outcome) {
      if (outcome.outcome !== "ok") return false;
      const text = typeof outcome.value === "string" ? outcome.value : JSON.stringify(outcome.value);
      received.push(text);
      ctx.captures.add(label, text);
      return true;
    },
  };
}

const leaks = (texts) => texts.filter((t) => SENTINELS.some((s) => t.includes(s)));
const wellFormed = (o) => {
  if (!OUTCOMES.includes(o?.outcome)) return false;
  if (o.outcome === "ok") return "value" in o && Array.isArray(o.findings) && !("reason" in o);
  // A non-ok outcome carries no value and no findings.
  return !("value" in o) && !("findings" in o);
};

async function boundary(options) {
  const { createAiContextBoundary } = await adapterMod();
  return createAiContextBoundary(options);
}

function child(ctx, profile) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [join(ctx.appDir, "lib", "aictx-child.mjs"), profile],
      {
        cwd: ctx.appDir,
        timeout: 15000,
        maxBuffer: 1024 * 1024,
        env: { PATH: process.env.PATH, NODE_ENV: "production" },
      },
      (err, stdout) => {
        if (err) return reject(new Error("child failed"));
        try {
          resolve(JSON.parse(stdout.trim().split("\n").at(-1)));
        } catch {
          reject(new Error("child output unreadable"));
        }
      },
    );
  });
}

const installed = (ctx, name) => ctx.install.adapters.find((a) => a.name === name);

export const scenarios = [
  {
    id: "aictx.text-and-value-ok",
    title: "Text and key-aware structured values are redacted to ok outcomes; only ok.value reaches the recipient",
    classification: "qualification",
    async run(ctx, rec) {
      const b = await boundary();
      const down = makeDownstream(ctx, "aictx.text-and-value-ok");
      const text = b.sanitizeText(`토큰 ${TOKEN} \u{1F680} 끝`, { boundary: "user-input" });
      rec.check("text outcome is ok", text.outcome === "ok" && wellFormed(text));
      rec.check(
        "Unicode text keeps its shape around the placeholder",
        /^토큰 <SECRET_\d+> \u{1F680} 끝$/u.test(text.value ?? ""),
      );
      rec.check(
        "the finding is the eight allowlisted fields",
        text.findings?.length === 1 &&
          JSON.stringify(Object.keys(text.findings[0]).sort()) === JSON.stringify(SAFE_FINDING_FIELDS),
      );
      rec.check(
        "the finding range indexes the scanned text",
        text.findings?.[0]?.start === 3 && text.findings?.[0]?.end === 3 + TOKEN.length,
      );
      const keyed = b.sanitizeValue({
        api_key: KEYED,
        name: KEYED,
        client_secret: "한국어-가짜-비밀번호-1234",
        nested: { list: [`x ${TOKEN}`] },
      });
      rec.check("key-aware structured value is ok", keyed.outcome === "ok" && wellFormed(keyed));
      rec.check("a secret-named key redacts its value", keyed.value?.api_key === "<SECRET_1>");
      rec.check("a Korean value under a secret key is redacted", keyed.value?.client_secret === "<SECRET_1>");
      rec.check("a benign key keeps its value", keyed.value?.name === KEYED);
      rec.check("a token nested in an array is redacted", !JSON.stringify(keyed.value).includes(TOKEN));
      const tool = b.sanitizeToolResult({ content: [{ type: "text", text: `out ${TOKEN}` }] });
      rec.check(
        "a tool result goes through the same boundary",
        tool.outcome === "ok" && !JSON.stringify(tool.value).includes(TOKEN),
      );
      for (const o of [text, keyed, tool]) down.forward(o);
      rec.check("the recipient received three redacted payloads", down.received.length === 3);
      rec.check("the recipient received no sentinel", leaks(down.received).length === 0);
      rec.evidence.recipientPayloads = down.received.length;
    },
  },
  {
    id: "aictx.build-context-parts",
    title: "A multi-part context is all-or-nothing: one bad part makes the whole context blocked and forwards nothing",
    classification: "qualification",
    async run(ctx, rec) {
      const b = await boundary();
      const down = makeDownstream(ctx, "aictx.build-context-parts");
      const parts = [
        { role: "user", boundary: "user-input", text: `deploy with API_KEY=${TOKEN}` },
        {
          role: "tool",
          boundary: "tool-result",
          value: { content: [{ type: "text", text: "build ok" }], exitCode: 0 },
        },
        { role: "system", text: "fixed instruction" },
      ];
      const ok = b.buildContext(parts);
      rec.check("context is ok", ok.outcome === "ok" && wellFormed(ok));
      rec.check(
        "one message per part, in order",
        Array.isArray(ok.value) && ok.value.map((m) => m.role).join() === "user,tool,system",
      );
      rec.check("the text part is redacted", !JSON.stringify(ok.value).includes(TOKEN));
      rec.check("the structured part is intact", ok.value?.[1]?.content?.exitCode === 0);
      rec.check("the untouched part is unchanged", ok.value?.[2]?.content === "fixed instruction");
      rec.check("findings come from the redacted part only", ok.findings?.length === 1);
      down.forward(ok);
      const bad = b.buildContext([...parts, { role: "user", text: PEM }]);
      rec.check(
        "a blocking part blocks the whole context",
        bad.outcome === "blocked" && bad.reason === "policy" && wellFormed(bad),
      );
      down.forward(bad);
      const unsupported = b.buildContext([parts[0], { role: "user", value: () => 1 }]);
      rec.check(
        "an unsupported part blocks the whole context",
        unsupported.outcome === "blocked" && unsupported.reason === "unsupported_value",
      );
      down.forward(unsupported);
      const notAnArray = b.buildContext("not an array");
      rec.check(
        "a non-array parts argument is unsupported_value",
        notAnArray.outcome === "blocked" && notAnArray.reason === "unsupported_value",
      );
      rec.check("exactly one context reached the recipient", down.received.length === 1);
      rec.check("no partial content of a refused context reached the recipient", leaks(down.received).length === 0);
    },
  },
  {
    id: "aictx.policy-warn-block",
    title:
      "Default policy warns without changing text and blocks a private key; explicit policies block, redact and fail closed",
    classification: "negative-control",
    async run(ctx, rec) {
      const down = makeDownstream(ctx, "aictx.policy-warn-block");
      const b = await boundary();
      const warn = b.sanitizeText(WARN_ONLY);
      rec.check("warn: outcome ok", warn.outcome === "ok");
      rec.check("warn: the text is unchanged", warn.value === WARN_ONLY);
      rec.check(
        "warn: the finding is reported with action warn",
        warn.findings?.length === 1 && warn.findings[0].action === "warn",
      );
      const block = b.sanitizeText(PEM);
      rec.check(
        "block: a private key is blocked by policy",
        block.outcome === "blocked" && block.reason === "policy" && wellFormed(block),
      );
      const blockValue = b.sanitizeValue({ deep: { pem: PEM } });
      rec.check(
        "block: the same key in a structure is blocked",
        blockValue.outcome === "blocked" && blockValue.reason === "policy",
      );
      down.forward(warn);
      down.forward(block);
      down.forward(blockValue);
      rec.check(
        "only the warn value (unchanged by policy) was forwarded",
        down.received.length === 1 && down.received[0] === WARN_ONLY,
      );

      const blockAll = await boundary({ policy: { evaluate: () => "block" } });
      const bo = blockAll.sanitizeText(`x ${TOKEN}`);
      rec.check("explicit policy block: blocked/policy", bo.outcome === "blocked" && bo.reason === "policy");
      const redactAll = await boundary({ policy: { evaluate: () => "redact" } });
      const ro = redactAll.sanitizeText(WARN_ONLY);
      rec.check(
        "explicit policy redact: the warn value is redacted",
        ro.outcome === "ok" && ro.value === "password=<SECRET_1>",
      );
      const throwing = await boundary({
        policy: {
          evaluate: () => {
            throw new Error("synthetic policy failure");
          },
        },
      });
      const to = throwing.sanitizeText(`x ${TOKEN}`);
      rec.check(
        "a throwing policy fails closed as core_error/POLICY_FAILURE",
        to.outcome === "blocked" && to.reason === "core_error" && to.code === "POLICY_FAILURE",
      );
      const tv = throwing.sanitizeValue({ a: `x ${TOKEN}` });
      rec.check(
        "a throwing policy fails a structured value closed too",
        tv.outcome === "blocked" && tv.reason === "core_error",
      );
      rec.check(
        "no refused outcome carries a value",
        [bo, to, tv].every((o) => wellFormed(o)),
      );
    },
  },
  {
    id: "aictx.limits",
    title: "Whole-input, traversal and stream limits end in blocked/limit_exceeded with no value",
    classification: "negative-control",
    async run(ctx, rec) {
      const down = makeDownstream(ctx, "aictx.limits");
      const b = await boundary(TINY);
      const big = b.sanitizeText("a".repeat(65));
      rec.check(
        "input over maxInputBytes is limit_exceeded",
        big.outcome === "blocked" &&
          big.reason === "limit_exceeded" &&
          big.code === "INPUT_LIMIT_EXCEEDED" &&
          wellFormed(big),
      );
      const wide = b.sanitizeValue([1, 2, 3, 4, 5, 6, 7]);
      rec.check(
        "more than maxNodes values is limit_exceeded",
        wide.outcome === "blocked" && wide.reason === "limit_exceeded",
      );
      const deep = b.sanitizeValue({ a: { b: { c: { d: 1 } } } });
      rec.check(
        "deeper than maxDepth is limit_exceeded",
        deep.outcome === "blocked" && deep.reason === "limit_exceeded",
      );
      const within = b.sanitizeValue({ a: { b: { c: 1 } } });
      rec.check("a value within the limits is ok", within.outcome === "ok");
      const ctxLimit = b.buildContext([
        { role: "user", text: "fine" },
        { role: "user", text: "a".repeat(65) },
      ]);
      rec.check(
        "one over-limit part makes the context limit_exceeded",
        ctxLimit.outcome === "blocked" && ctxLimit.reason === "limit_exceeded",
      );
      const s = b.openStream();
      let pulled = 0;
      for (let i = 0; i < 20 && s.accepting; i += 1) {
        s.append("word ".repeat(200));
        pulled += 1;
      }
      rec.check(
        "a stream over its limits stops accepting before the producer is exhausted",
        s.accepting === false && pulled < 20,
      );
      const fin = s.finalize();
      rec.check(
        "the limited stream finalizes as limit_exceeded",
        fin.outcome === "blocked" && fin.reason === "limit_exceeded" && wellFormed(fin),
      );
      for (const o of [big, wide, deep, ctxLimit, fin]) down.forward(o);
      down.forward(within);
      rec.check("only the in-limit value reached the recipient", down.received.length === 1);
    },
  },
  {
    id: "aictx.unsupported-values",
    title: "Values the boundary cannot represent are blocked/unsupported_value, never partly passed",
    classification: "negative-control",
    async run(ctx, rec) {
      const b = await boundary();
      const down = makeDownstream(ctx, "aictx.unsupported-values");
      const cyclic = {};
      cyclic.self = cyclic;
      const cases = [
        ["a number as text", () => b.sanitizeText(5)],
        ["a function", () => b.sanitizeValue(() => 1)],
        ["a bigint member", () => b.sanitizeValue({ a: 1n })],
        ["undefined", () => b.sanitizeValue(undefined)],
        ["a Date", () => b.sanitizeValue(new Date(0))],
        ["a cycle", () => b.sanitizeValue(cyclic)],
        ["NaN", () => b.sanitizeValue({ a: Number.NaN })],
        ["a symbol member", () => b.sanitizeValue({ a: Symbol("synthetic") })],
        ["a tool result that is a function", () => b.sanitizeToolResult(() => 1)],
      ];
      for (const [name, call] of cases) {
        let o;
        try {
          o = call();
        } catch {
          rec.check(`${name}: returns an outcome, does not throw`, false, "threw");
          continue;
        }
        rec.check(
          `${name}: blocked/unsupported_value`,
          o.outcome === "blocked" && o.reason === "unsupported_value" && wellFormed(o),
        );
        down.forward(o);
      }
      const s = b.openStream();
      s.append(5);
      const sf = s.finalize();
      rec.check(
        "a non-string stream chunk is blocked/unsupported_value",
        sf.outcome === "blocked" && sf.reason === "unsupported_value",
      );
      rec.check("the stream stops accepting after an unsupported chunk", s.accepting === false);
      rec.check("nothing reached the recipient", down.received.length === 0);
    },
  },
  {
    id: "aictx.aborted",
    title: "A cancelled signal ends every operation as aborted with no value",
    classification: "negative-control",
    async run(ctx, rec) {
      const b = await boundary();
      const down = makeDownstream(ctx, "aictx.aborted");
      const ac = new AbortController();
      ac.abort();
      const { signal } = ac;
      const results = [
        ["sanitizeText", b.sanitizeText(`x ${TOKEN}`, { signal })],
        ["sanitizeValue", b.sanitizeValue({ a: `x ${TOKEN}` }, { signal })],
        ["sanitizeToolResult", b.sanitizeToolResult({ a: "x" }, { signal })],
        ["buildContext", b.buildContext([{ role: "user", text: "x" }], { signal })],
      ];
      for (const [name, o] of results) {
        rec.check(`${name}: aborted`, o.outcome === "aborted" && wellFormed(o));
        down.forward(o);
      }
      const pre = b.openStream({ signal });
      rec.check("a stream opened on a cancelled signal is not accepting", pre.accepting === false);
      pre.append("x");
      rec.check("...and finalizes as aborted", pre.finalize().outcome === "aborted");
      const live = new AbortController();
      const mid = b.openStream({ signal: live.signal });
      mid.append(`part ${TOKEN.slice(0, 12)}`);
      live.abort();
      rec.check("cancelling a signal mid-stream stops accepting", mid.accepting === false);
      mid.append(TOKEN.slice(12));
      const fin = mid.finalize();
      rec.check("...and finalizes as aborted, releasing nothing", fin.outcome === "aborted" && wellFormed(fin));
      down.forward(fin);
      rec.check("nothing reached the recipient", down.received.length === 0);
    },
  },
  {
    id: "aictx.init-failure",
    title: "Initialization failures fail closed: no operation produces a value",
    classification: "failure-injection",
    async run(ctx, rec) {
      const { createAiContextBoundary, createAiContextBoundaryWith } = await adapterMod();
      const down = makeDownstream(ctx, "aictx.init-failure");
      let threw = 0;
      for (const bad of [null, "options"]) {
        try {
          await createAiContextBoundary(bad);
        } catch (err) {
          if (err instanceof TypeError) threw += 1;
        }
      }
      rec.check("malformed options are a TypeError before any core is touched", threw === 2);
      // A fake core whose scan and stream creation throw: the factory-injected equivalent of a core that cannot load.
      const boom = () => {
        throw new Error("synthetic core failure");
      };
      const failing = createAiContextBoundaryWith({ scanAndRedact: boom, createIncrementalSanitizer: boom }, TINY);
      const o = failing.sanitizeText(`x ${TOKEN}`);
      rec.check(
        "a failing core makes sanitizeText blocked/core_error",
        o.outcome === "blocked" && o.reason === "core_error" && wellFormed(o),
      );
      const v = failing.sanitizeValue({ a: "x" });
      rec.check("...and sanitizeValue", v.outcome === "blocked" && v.reason === "core_error");
      const s = failing.openStream();
      rec.check("...and a stream is not accepting", s.accepting === false);
      const f = s.finalize();
      rec.check("...and finalizes blocked/core_error", f.outcome === "blocked" && f.reason === "core_error");
      for (const x of [o, v, f]) down.forward(x);
      // A real activation failure (an unknown PII selector) needs its own process.
      const bad = await child(ctx, "bad-pii");
      rec.check(
        "an unknown PII selector: every operation is blocked/core_error",
        [bad.text, bad.value, bad.context, bad.stream.final].every((x) => x.o === "blocked" && x.r === "core_error"),
      );
      rec.check("...and the stream is not accepting", bad.stream.accepting === false);
      rec.check("...and the core reports no active artifact", bad.artifact === null);
      rec.check("nothing reached the recipient", down.received.length === 0);
    },
  },
  {
    id: "aictx.stream-lifecycle",
    title:
      "Incremental append/finalize/abort: nothing is released before finalize, finalize releases once, misuse is blocked/lifecycle",
    classification: "qualification",
    async run(ctx, rec) {
      const b = await boundary();
      const down = makeDownstream(ctx, "aictx.stream-lifecycle");
      const text = `line one\nAPI_KEY=${TOKEN}\n\u{1F680} done\n`;
      const whole = b.sanitizeText(text);
      const s = b.openStream({ boundary: "tool-result" });
      rec.check("a fresh stream accepts", s.accepting === true);
      // The token is split across chunks: no chunk contains it whole.
      const chunks = [text.slice(0, 20), text.slice(20, 35), text.slice(35, 50), text.slice(50)];
      let released = 0;
      chunks.forEach((chunk, i) => {
        const ret = s.append(chunk);
        if (ret !== undefined) released += 1;
        rec.check(
          `append #${i + 1} releases nothing and the stream keeps accepting`,
          ret === undefined && s.accepting === true,
        );
      });
      rec.check("no progressive release across all appends", released === 0 && down.received.length === 0);
      const fin = s.finalize();
      rec.check("finalize returns ok", fin.outcome === "ok" && wellFormed(fin));
      rec.check("the finalized value equals the whole-input value", fin.value === whole.value);
      rec.check("the finalized value hides the token", !fin.value.includes(TOKEN));
      rec.check("stream findings use absolute offsets", fin.findings?.length === 1 && fin.findings[0].start === 17);
      rec.check("a finalized stream no longer accepts", s.accepting === false);
      down.forward(fin);
      s.append("late chunk");
      const again = s.finalize();
      rec.check(
        "a second finalize is blocked/lifecycle with no value",
        again.outcome === "blocked" && again.reason === "lifecycle" && wellFormed(again),
      );
      down.forward(again);
      s.abort();
      rec.check("abort after finalize does nothing harmful", s.accepting === false);
      const a = b.openStream();
      a.append(`x ${TOKEN}`);
      a.abort();
      rec.check("abort stops accepting", a.accepting === false);
      a.append("more");
      const af = a.finalize();
      rec.check("finalize after abort is aborted, no value", af.outcome === "aborted" && wellFormed(af));
      down.forward(af);
      const empty = b.openStream().finalize();
      rec.check("an empty stream finalizes ok with an empty value", empty.outcome === "ok" && empty.value === "");
      const half = b.openStream();
      half.append("\ud83d");
      const hf = half.finalize();
      rec.check(
        "a lone surrogate at finalize is refused (UNPAIRED_SURROGATE)",
        hf.outcome === "blocked" && hf.code === "UNPAIRED_SURROGATE",
      );
      rec.check(
        "exactly one stream result reached the recipient",
        down.received.length === 1 && down.received[0] === fin.value,
      );
      rec.check("the recipient received no sentinel", leaks(down.received).length === 0);
    },
  },
  {
    id: "aictx.stream-producer-shutdown",
    title:
      "A blocked stream reports accepting=false so the producer stops; later chunks are discarded, nothing is released",
    classification: "negative-control",
    async run(ctx, rec) {
      const b = await boundary();
      const down = makeDownstream(ctx, "aictx.stream-producer-shutdown");
      const chunks = [
        "ok\n",
        "-----BEGIN PRIVATE KEY-----\n",
        "U1lOVEhFVElDX1JFVk9LRURfQ09ORk9STUFOQ0U=\n",
        "-----END PRIVATE KEY-----\n",
        "tail one\n",
        "tail two\n",
      ];
      let pulled = 0;
      let cancelled = false;
      const s = b.openStream({ boundary: "tool-result" });
      for (const chunk of chunks) {
        if (!s.accepting) {
          cancelled = true; // the application cancels its producer here
          break;
        }
        pulled += 1;
        s.append(chunk);
      }
      rec.check("the producer was cancelled once accepting turned false", cancelled === true);
      rec.check("...before it was exhausted", pulled < chunks.length);
      rec.check("accepting is false after a block finding", s.accepting === false);
      s.append("discarded chunk");
      const fin = s.finalize();
      rec.check(
        "finalize reports blocked/policy, no value, no findings",
        fin.outcome === "blocked" && fin.reason === "policy" && wellFormed(fin),
      );
      down.forward(fin);
      rec.check("the recipient received neither the original nor a partial", down.received.length === 0);
      const again = s.finalize();
      rec.check(
        "a repeated finalize is blocked/lifecycle",
        again.outcome === "blocked" && again.reason === "lifecycle",
      );
      // A warn-only stream stays accepting and ends ok, unchanged.
      const w = b.openStream();
      w.append("note ");
      w.append(WARN_ONLY);
      rec.check("a warn finding does not stop the stream", w.accepting === true);
      const wf = w.finalize();
      rec.check("...it finalizes ok with the text unchanged", wf.outcome === "ok" && wf.value === `note ${WARN_ONLY}`);
      rec.evidence.pulled = pulled;
      rec.evidence.total = chunks.length;
    },
  },
  {
    id: "aictx.downstream-forwarding",
    title: "Across ok, blocked and aborted the recipient gets only ok.value, never an original or a partial",
    classification: "qualification",
    async run(ctx, rec) {
      const b = await boundary();
      const down = makeDownstream(ctx, "aictx.downstream-forwarding");
      const ac = new AbortController();
      ac.abort();
      const inputs = [
        ["ok", () => b.sanitizeText(`use ${TOKEN}`), true],
        ["blocked/policy", () => b.sanitizeText(PEM), false],
        ["blocked/unsupported", () => b.sanitizeValue(() => 1), false],
        ["aborted", () => b.sanitizeText(`use ${TOKEN}`, { signal: ac.signal }), false],
        ["ok value", () => b.sanitizeValue({ api_key: KEYED, note: "plain" }), true],
      ];
      for (const [name, call, shouldForward] of inputs) {
        const before = down.received.length;
        const o = call();
        const forwarded = down.forward(o);
        rec.check(
          `${name}: ${shouldForward ? "forwarded" : "not forwarded"}`,
          forwarded === shouldForward && down.received.length === before + (shouldForward ? 1 : 0),
        );
      }
      rec.check("the recipient holds exactly the redacted payloads", down.received.length === 2);
      rec.check(
        "no original secret or key material reached the recipient",
        leaks(down.received).length === 0 && !down.received.join("").includes(KEYED),
      );
      const total = down.received.join("");
      rec.check("redaction placeholders are present in what was forwarded", total.includes("<SECRET_"));
    },
  },
  {
    id: "aictx.pii-isolated-processes",
    title: "PII configurations run in separate processes; init order is explicit and misuse fails closed",
    classification: "qualification",
    async run(ctx, rec) {
      const plain = await child(ctx, "default");
      const pii = await child(ctx, "pii");
      rec.check("default: the shared cases hold with PII off", plain.failures.length === 0);
      rec.check("pii: the shared cases hold with PII on", pii.failures.length === 0);
      rec.check(
        "PII off and on differ only in the address case",
        plain.digests.email !== pii.digests.email &&
          plain.digests.text === pii.digests.text &&
          plain.digests.keyAware === pii.digests.keyAware &&
          plain.digests.whole === pii.digests.whole,
      );
      rec.check(
        "the warn-only value is a warn in both processes",
        plain.warn.o === "ok" && plain.warn.f[0].endsWith("/warn@9-23") && pii.warn.f[0].endsWith("/warn@9-23"),
      );
      const policy = await child(ctx, "policy");
      rec.check(
        "explicit policy (PII on): the address is redacted",
        policy.email.o === "ok" &&
          !policy.email.v.includes(EMAIL) &&
          policy.email.f.some((f) => f.includes("/redact@")),
      );
      rec.check(
        "explicit policy: the warn-only value is redacted, not warned",
        policy.warn.v === "password=<SECRET_1>" && policy.warn.f[0].includes("/redact@"),
      );
      rec.check(
        "explicit policy: the private key still blocks",
        policy.pem.o === "blocked" && policy.pem.r === "policy",
      );
      const first = await child(ctx, "pii-first");
      rec.check(
        "PII activation is process-wide: a later PII-less boundary shares it",
        first.first.v === first.second.v && !first.second.v.includes(EMAIL),
      );
      const late = await child(ctx, "late-pii");
      rec.check(
        "PII requested after the core was initialized without it fails closed",
        late.late.o === "blocked" && late.late.r === "core_error",
      );
      rec.check(
        "...its stream does not accept and finalizes blocked",
        late.lateStream.accepting === false && late.lateStream.final.o === "blocked",
      );
      rec.check(
        "...and the earlier PII-off boundary is unaffected",
        late.first.o === "ok" && late.first.v.includes(EMAIL),
      );
      rec.check(
        "every configuration used its own process",
        new Set([plain, pii, policy, first, late].map((p) => p.profile)).size === 5,
      );
      rec.evidence.artifacts = { default: plain.artifact, pii: pii.artifact };
    },
  },
  {
    id: "aictx.shared-baseline",
    title: "Server baseline of the shared synthetic cases (PII off and on) that the browser lane must match",
    classification: "qualification",
    async run(ctx, rec) {
      const plain = await child(ctx, "default");
      const pii = await child(ctx, "pii");
      rec.check(
        "the server meets the shared expectations with PII off",
        Array.isArray(plain.failures) && plain.failures.length === 0,
      );
      rec.check(
        "the server meets the shared expectations with PII on",
        Array.isArray(pii.failures) && pii.failures.length === 0,
      );
      rec.check("the lifecycle and outcome behaviors all hold (PII off)", Object.values(plain.behavior).every(Boolean));
      rec.check("the lifecycle and outcome behaviors all hold (PII on)", Object.values(pii.behavior).every(Boolean));
      rec.evidence.artifact = plain.artifact;
      rec.evidence.digests = { off: plain.digests, on: pii.digests };
      rec.evidence.behavior = { off: plain.behavior, on: pii.behavior };
    },
  },
  {
    id: "aictx.candidate-features",
    title:
      "Features newer than the pinned release (option rejection, occurrence provenance, operation budget, readiness) where installed",
    classification: "qualification",
    async run(ctx, rec) {
      const mod = await adapterMod();
      const adapter = installed(ctx, "@redact-secret/adapter-ai-context");
      rec.evidence.adapterVersion = adapter?.version ?? null;
      rec.evidence.mode = ctx.install.mode;
      const present = typeof mod.findingOccurrences === "function" && typeof mod.checkAiContextReady === "function";
      rec.evidence.featuresInstalled = present;
      if (!present) {
        if (ctx.install.mode === "candidate") {
          rec.check(
            "candidate artifact exposes findingOccurrences and checkAiContextReady",
            false,
            "feature missing in candidate",
          );
        } else {
          rec.unsupported("installed published release predates occurrence provenance and the readiness check");
        }
        return;
      }
      let rejected = 0;
      for (const bad of [{ ruleset: {} }, { scanLimits: {} }]) {
        try {
          await mod.createAiContextBoundary(bad);
        } catch (err) {
          if (err instanceof TypeError) rejected += 1;
        }
      }
      rec.check("options the boundary does not take (ruleset, scanLimits) are rejected by name", rejected === 2);
      const b = await mod.createAiContextBoundary();
      const o = b.sanitizeValue({ api_key: KEYED, items: [`x ${TOKEN}`] });
      const occ = mod.findingOccurrences(o);
      rec.check(
        "one occurrence per finding",
        o.outcome === "ok" && occ.length === o.findings.length && occ.length === 2,
      );
      rec.check(
        "occurrences are leaves with ordinals",
        occ.every(
          (x) => x.rangeScope === "leaf" && Number.isInteger(x.leafOrdinal) && x.rangeUnit === "utf16-code-units",
        ),
      );
      rec.check("an outcome's JSON does not carry occurrences", !JSON.stringify(o).includes("leafOrdinal"));
      const limited = await mod.createAiContextBoundary({ operationLimits: { maxNodes: 3 } });
      const l = limited.sanitizeValue([1, 2, 3, 4, 5, 6]);
      rec.check(
        "the per-operation budget ends in limit_exceeded",
        l.outcome === "blocked" && l.reason === "limit_exceeded" && wellFormed(l),
      );
      const ready = await mod.checkAiContextReady();
      rec.check(
        "the readiness check resolves ready with a fixed status",
        ready.ready === true && ready.status === "ready",
      );
      rec.evidence.readiness = { status: ready.status, pii: ready.pii };
    },
  },
];
