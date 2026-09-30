import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Runs before `vitest.global-setup.ts` when Stryker drives Vitest
 * (`vitest.stryker.config.ts`). Stryker copies the checkout into
 * `.stryker-tmp/sandbox-*` but symlinks `node_modules` back to the checkout,
 * and the npm workspace links in it are relative, so `@redact-secret/adapter`
 * and `@redact-secret/adapter-otel-trace` resolve to the checkout's `dist/`, not
 * the sandbox's. The global setup builds only the sandbox. When the checkout was
 * never built, Vitest cannot resolve those imports: in `related` mode it finds no
 * tests and Stryker stops ("No tests were executed").
 *
 * This builds the checkout that the links point at, from its unmutated source,
 * but only when a workspace package has no `dist/index.js`. The dry run is a
 * single process, so later mutant workers find `dist/` present and never build
 * concurrently. It does not rebuild a stale `dist/`; run `npm run build` after
 * changing another package's source.
 */
export default function setup(): void {
  const sandbox = realpathSync(process.cwd());
  const checkout = dirname(dirname(realpathSync(resolve(sandbox, "node_modules/@redact-secret/adapter"))));
  if (checkout === sandbox) return;
  const workspaces = (JSON.parse(readFileSync(join(checkout, "package.json"), "utf-8")) as { workspaces: string[] })
    .workspaces;
  if (workspaces.every((dir) => existsSync(join(checkout, dir, "dist", "index.js")))) return;
  execFileSync("npm", ["run", "build", "--silent"], { cwd: checkout, stdio: "inherit" });
}
