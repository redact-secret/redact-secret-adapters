import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import { BasicTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { createRedactingSpanProcessor } from "@redact-secret/adapter-otel-trace";
import { TOKEN } from "./verify.mjs";

/**
 * An exporter that keeps the OTLP/JSON request body an http/json exporter would send. Swap it for
 * the serialization your real exporter uses, still pointed at memory and never at a collector.
 */
function capturingExporter() {
  const exporter = {
    text: "",
    export(spans, done) {
      exporter.text += new TextDecoder().decode(JsonTraceSerializer.serializeRequest(spans));
      done({ code: 0 });
    },
    shutdown: async () => {},
  };
  return exporter;
}

async function emitOneSpan(spanProcessors) {
  const provider = new BasicTracerProvider({ spanProcessors });
  const span = provider.getTracer("placement").startSpan(`deploy ${TOKEN}`);
  span.setAttribute("llm.input_messages", `deploy with token ${TOKEN}`);
  span.addEvent("tool_call", { "tool.args": `Bearer ${TOKEN}` });
  span.end();
  await provider.shutdown();
}

// One provider, two destinations. Registration is what decides which one is protected.
const destinations = (async () => {
  const guarded = capturingExporter();
  const sibling = capturingExporter();
  // snippet:start otel-protected
  await emitOneSpan([
    // Control: a processor registered AHEAD of the redacting one sees the span before it is redacted.
    new SimpleSpanProcessor(sibling),
    // Wrap the processor that feeds the exporter. The redacting processor goes around it, not beside it.
    await createRedactingSpanProcessor(new SimpleSpanProcessor(guarded)),
  ]);
  // snippet:end otel-protected
  return { guarded, sibling };
})();

export const otelRecipes = [
  {
    label: "otel traces: exporter behind createRedactingSpanProcessor() (name, attribute, event)",
    capture: async () => (await destinations).guarded.text,
  },
  {
    label: "otel traces: exporter on a processor registered ahead of the redacting one",
    control: true,
    capture: async () => (await destinations).sibling.text,
  },
];
