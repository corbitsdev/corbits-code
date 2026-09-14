import { describe, expect, test } from "bun:test";

import {
  evaluateGuard,
  isAllowlisted,
  loadAllowlist,
  parseAllowlistText,
  parseTsPruneLine,
} from "./check-dead-exports.js";

// A probe dead export in one of the scoped files must fail the guard: the
// exact-name exemptions cover only the five deferred-cleanup flags, never
// the whole module.
describe("scoped exemptions", () => {
  test("the real allowlist covers the named flags but not a sibling probe", () => {
    const rules = loadAllowlist();
    expect(
      isAllowlisted(rules, "src/auth/codex/usage.ts", "fetchCodexUsage"),
    ).toBe(true);
    expect(
      isAllowlisted(rules, "src/auth/codex/usage.ts", "fetchCodexModels"),
    ).toBe(true);
    expect(isAllowlisted(rules, "src/auth/xai/usage.ts", "fetchXaiUsage")).toBe(
      true,
    );
    expect(
      isAllowlisted(
        rules,
        "src/auth/codex/constants.ts",
        "CODEX_REFRESH_SKEW_MS",
      ),
    ).toBe(true);
    expect(
      isAllowlisted(
        rules,
        "src/auth/codex/constants.ts",
        "CODEX_HEADLESS_REFRESH_INTERVAL_MS",
      ),
    ).toBe(true);
    expect(
      isAllowlisted(rules, "src/auth/codex/usage.ts", "someNewDeadExport"),
    ).toBe(false);
  });

  test("a probe dead export in a scoped file is a violation", () => {
    const rules = parseAllowlistText(
      "src/auth/codex/usage.ts: fetchCodexUsage\n",
    );
    const outcome = evaluateGuard(
      rules,
      "src/auth/codex/usage.ts:114 - fetchCodexUsage\n" +
        "src/auth/codex/usage.ts:200 - someNewDeadExport\n",
    );
    expect(outcome.dead).toBe(2);
    expect(outcome.violations).toEqual([
      "src/auth/codex/usage.ts: someNewDeadExport",
    ]);
    expect(outcome.unused).toEqual([]);
  });

  test("exports used only inside their own module do not count", () => {
    const outcome = evaluateGuard(
      [],
      "src/inference-abort.ts:5 - InferenceAbortReason (used in module)\n",
    );
    expect(outcome.dead).toBe(0);
    expect(outcome.violations).toEqual([]);
  });

  test("parseTsPruneLine skips blank and unparseable lines", () => {
    expect(parseTsPruneLine("")).toBeUndefined();
    expect(parseTsPruneLine("not a ts-prune line")).toBeUndefined();
    expect(
      parseTsPruneLine("src/auth/xai/usage.ts:89 - fetchXaiUsage"),
    ).toEqual({ file: "src/auth/xai/usage.ts", name: "fetchXaiUsage" });
  });
});

// Allowlist entries that match no current ts-prune flag are stale: report
// them so the exemption is removed with the code it covered, without
// failing the gate on their own.
describe("stale allowlist entries", () => {
  test("an entry matching nothing is reported as unused, not a violation", () => {
    const rules = parseAllowlistText(
      "src/auth/xai/usage.ts: fetchXaiUsage\n" +
        "src/gone.ts: vanishedExport\n",
    );
    const outcome = evaluateGuard(
      rules,
      "src/auth/xai/usage.ts:89 - fetchXaiUsage\n",
    );
    expect(outcome.violations).toEqual([]);
    expect(outcome.unused).toEqual(["src/gone.ts: vanishedExport"]);
  });

  test("a fully fresh allowlist reports no unused entries", () => {
    const rules = parseAllowlistText(
      "vendor/\nsrc/auth/xai/usage.ts: fetchXaiUsage\n",
    );
    const outcome = evaluateGuard(
      rules,
      "vendor/intx-types/src/index.ts:3 - ErrorResponse\n" +
        "src/auth/xai/usage.ts:89 - fetchXaiUsage\n",
    );
    expect(outcome.violations).toEqual([]);
    expect(outcome.unused).toEqual([]);
  });

  test("a prefix entry counts as used when any flag falls under it", () => {
    const rules = parseAllowlistText("vendor/\n");
    const outcome = evaluateGuard(
      rules,
      "vendor/intx-types/src/index.ts:3 - ErrorResponse\n",
    );
    expect(outcome.violations).toEqual([]);
    expect(outcome.unused).toEqual([]);
  });
});
