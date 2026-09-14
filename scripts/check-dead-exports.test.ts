import { spawnSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  evaluateGuard,
  isAllowlisted,
  loadAllowlist,
  parseAllowlistText,
  parseTsPruneLine,
} from "./check-dead-exports.js";

const repoRoot = join(import.meta.dir, "..");

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

// The unit tests above prove the rule engine flags a probe; this one proves
// the wired-up gate does. A temp probe export lands in the tsconfig-covered
// scripts/ tree, the real guard runs as a subprocess, and the run must exit
// nonzero naming the probe. The probe lives only for the test (never
// committed) so the keep-alive check cannot itself become a dead export.
describe("violation end to end", () => {
  test("a temp dead export fails the guard, which names it", () => {
    const probeFile = `dead-export-guard-probe-${process.pid}.ts`;
    const probeName = `deadExportGuardProbe${process.pid}`;
    const probePath = join(repoRoot, "scripts", probeFile);
    writeFileSync(probePath, `export const ${probeName} = 1;\n`);
    try {
      const ran = spawnSync(
        process.execPath,
        ["scripts/check-dead-exports.ts"],
        { cwd: repoRoot, encoding: "utf8" },
      );
      expect(ran.status).toBe(1);
      expect(`${ran.stdout}\n${ran.stderr}`).toContain(
        `${probeFile}: ${probeName}`,
      );
    } finally {
      rmSync(probePath, { force: true });
    }
  }, 60_000);
});

// The purge deleted four fully-dead barrel files; a re-created barrel (or a
// new import of its path) would silently resurrect the surface the guard was
// built to shrink. Pin the paths, not the file text.
describe("deleted barrels stay deleted", () => {
  const barrels = [
    "src/agent/directors/index.ts",
    "src/auth/codex/index.ts",
    "src/auth/xai/index.ts",
    "src/web/index.ts",
  ];
  const barrelDirs = barrels.map((barrel) =>
    barrel.slice(0, -"/index.ts".length),
  );
  const barrelTails = [
    "agent/directors/index",
    "auth/codex/index",
    "auth/xai/index",
    "web/index",
  ];
  const roots = ["src", "tests", "evals", "scripts", "packages"];

  test("the barrel files do not exist", () => {
    for (const barrel of barrels) {
      expect(existsSync(join(repoRoot, barrel))).toBe(false);
    }
  });

  test("no source file imports the deleted barrel paths", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const absolute = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(absolute);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        const rel = relative(repoRoot, absolute).split("/").join("/");
        const dirRel = rel.slice(0, -entry.name.length - 1);
        const text = readFileSync(absolute, "utf8");
        const specifiers = [
          ...text.matchAll(/(?:from\s*["']|import\s*\(\s*["'])([^"']+)["']/g),
        ].map((match) => (match[1] ?? "").replace(/\.(?:js|ts)$/, ""));
        for (const spec of specifiers) {
          const hitsBarrel =
            barrelTails.some(
              (tail) => spec === tail || spec.endsWith(`/${tail}`),
            ) ||
            (spec === "./index" && barrelDirs.includes(dirRel));
          if (hitsBarrel) offenders.push(`${rel}: ${spec}`);
        }
      }
    };
    for (const root of roots) walk(join(repoRoot, root));
    expect(offenders).toEqual([]);
  });
});
