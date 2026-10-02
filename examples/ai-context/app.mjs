import { createAiContextBoundary } from "@redact-secret/adapter-ai-context";

// Synthetic, revoked-shaped values only. Never put a real credential in an example.
const userText = "deploy with API_KEY=ghp_SYNTHETICREVOKED00000000000000000000";
const toolResult = { content: [{ type: "text", text: "build ok" }], exitCode: 0 };

const boundary = await createAiContextBoundary();
const context = boundary.buildContext([
  { role: "user", boundary: "user-input", text: userText },
  { role: "tool", boundary: "tool-result", value: toolResult },
]);

if (context.outcome !== "ok") {
  // `reason` and `code` are fixed labels, safe to log. There is no value to use.
  throw new Error(`context refused: ${context.outcome} ${context.reason ?? ""}`);
}

// context.value is the only thing that may go to a model. This example prints it instead of calling one.
console.log(JSON.stringify(context.value));
