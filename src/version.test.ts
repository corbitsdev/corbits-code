/**
 * DISPLAY_VERSION resolution: the build-time injected `CORBITS_BUILD_INFO`
 * (bun build --define) wins when present, and plain `v<pkg.version>` is the
 * dev/test fallback when it is absent.
 *
 * `version.ts` reads the env var at module-evaluation time, so each case
 * imports it with a distinct cache-busting query: Bun keys the module
 * registry by resolved URL, so `?injected` re-evaluates the module with the
 * env var set even if `version.ts` was already evaluated in this process.
 */
import { describe, expect, test } from "bun:test";

import pkg from "../package.json" with { type: "json" };

const INJECTED_BUILD_INFO = "corbits 0.3.36-7-g9af7e1e3";

/**
 * Import `version.ts` under a cache-busting query so the module re-evaluates
 * with whatever `process.env.CORBITS_BUILD_INFO` is set to right now, even if
 * it was already evaluated earlier in this process. Cast through the plain
 * module type because the query-suffixed specifier is not a resolvable path.
 */
async function importVersion(
  scope: string,
): Promise<typeof import("./version.ts")> {
  return (await import(
    `./version.ts?${scope}`
  )) as typeof import("./version.ts");
}

describe("DISPLAY_VERSION", () => {
  test("resolves to the injected CORBITS_BUILD_INFO when set", async () => {
    const prior = process.env.CORBITS_BUILD_INFO;
    process.env.CORBITS_BUILD_INFO = INJECTED_BUILD_INFO;
    try {
      const { DISPLAY_VERSION } = await importVersion("injected=1");
      expect(DISPLAY_VERSION).toBe(INJECTED_BUILD_INFO);
    } finally {
      if (prior === undefined) delete process.env.CORBITS_BUILD_INFO;
      else process.env.CORBITS_BUILD_INFO = prior;
    }
  });

  test("falls back to `v${pkg.version}` when CORBITS_BUILD_INFO is unset", async () => {
    const prior = process.env.CORBITS_BUILD_INFO;
    delete process.env.CORBITS_BUILD_INFO;
    try {
      const { DISPLAY_VERSION } = await importVersion("fallback=1");
      expect(DISPLAY_VERSION).toBe(`v${pkg.version}`);
    } finally {
      if (prior === undefined) delete process.env.CORBITS_BUILD_INFO;
      else process.env.CORBITS_BUILD_INFO = prior;
    }
  });
});
