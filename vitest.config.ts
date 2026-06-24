import { defineConfig } from "vitest/config";

/**
 * Vitest config for Headroom's pure-logic layer.
 *
 * Scope is deliberately narrow: only `utils/` (pure functions, no browser API)
 * and adapter `parseDelete` parsing. DOM selectors, background messaging, and
 * side-panel UI are NOT unit-tested here — selector regressions are caught by
 * Playwright e2e, and the rest is integration-test territory.
 *
 * No alias/env setup is needed: the project uses relative imports and WXT's
 * auto-imports (defineBackground/browser) don't appear in the tested modules.
 */
export default defineConfig({
  test: {
    // Co-locate tests next to their source (*.test.ts) + allow a __tests__
    // dir for cross-module suites (e.g. adapter parse-request contracts).
    include: ["utils/**/*.test.ts", "adapters/**/*.test.ts"],
    // Run in node by default — none of the tested modules touch jsdom. Keeping
    // the default avoids pulling in the heavier jsdom environment for nothing.
    environment: "node",
  },
});
