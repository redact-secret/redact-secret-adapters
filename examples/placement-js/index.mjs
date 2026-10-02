import { otelRecipes } from "./otel-recipes.mjs";
import { pinoRecipes } from "./pino-recipes.mjs";
import { run } from "./verify.mjs";

await run([...pinoRecipes, ...otelRecipes]);
