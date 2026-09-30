import { defineConfig } from "vitest/config";

import base from "./vitest.config";

/**
 * The Vitest config Stryker runs (`stryker.config.json`). Same tests as
 * `vitest.config.ts`; `vitest.stryker-setup.ts` first builds the checkout that the
 * sandbox's workspace links resolve to, when it has no `dist/`.
 */
export default defineConfig({
  test: {
    ...base.test,
    globalSetup: ["./vitest.stryker-setup.ts", ...[base.test?.globalSetup ?? []].flat()],
  },
});
