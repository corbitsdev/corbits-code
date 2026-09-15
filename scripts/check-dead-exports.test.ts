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
  countScannedFiles,
  evaluateGuard,
  isAllowlisted,
  isCoverageEnough,
  isGuardPassing,
  loadAllowlist,
  loadGuardConfig,
  parseAllowlistText,
  parseGuardConfig,
  parseTsPruneLine,
  validateAllowlistEntry,
  validateAllowlistOwnership,
  validateAllowlistText,
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

// Allowlist entries that match no current ts-prune flag are stale: they fail
// the gate so the exemption is removed with the code it covered. Warn-only
// reporting let dead exemptions linger silently after the code was gone.
describe("stale allowlist entries", () => {
  test("an entry matching nothing is reported as unused and fails the gate", () => {
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
    expect(isGuardPassing(outcome)).toBe(false);
  });

  test("a fully fresh allowlist passes the gate", () => {
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
    expect(isGuardPassing(outcome)).toBe(true);
  });

  test("a prefix entry counts as used when any flag falls under it", () => {
    const rules = parseAllowlistText("vendor/\n");
    const outcome = evaluateGuard(
      rules,
      "vendor/intx-types/src/index.ts:3 - ErrorResponse\n",
    );
    expect(outcome.violations).toEqual([]);
    expect(outcome.unused).toEqual([]);
    expect(isGuardPassing(outcome)).toBe(true);
  });

  test("violations fail the gate", () => {
    const outcome = evaluateGuard([], "src/new.ts:1 - freshDeadExport\n");
    expect(outcome.violations).toEqual(["src/new.ts: freshDeadExport"]);
    expect(isGuardPassing(outcome)).toBe(false);
  });
});

// Entry shapes the matcher would silently misinterpret must fail validation
// instead: a mistyped exact entry must not decay into a prefix that matches
// nothing, and a directory without its trailing slash must not pass as an
// imprecise prefix.
describe("allowlist entry shapes", () => {
  test("valid entries pass", () => {
    expect(validateAllowlistEntry("vendor/")).toBeUndefined();
    expect(validateAllowlistEntry("src/auth/codex/usage.ts")).toBeUndefined();
    expect(
      validateAllowlistEntry("src/auth/codex/usage.ts: fetchCodexUsage"),
    ).toBeUndefined();
    expect(
      validateAllowlistEntry(
        "tests/fixtures/plugins/implement-feature/src/index.ts",
      ),
    ).toBeUndefined();
  });

  test("slash-less directory prefixes fail", () => {
    expect(validateAllowlistEntry("vendor")).toBeDefined();
    expect(validateAllowlistEntry("src/auth")).toBeDefined();
    expect(validateAllowlistEntry("/")).toBeDefined();
  });

  test("malformed exact entries fail instead of decaying into prefixes", () => {
    expect(
      validateAllowlistEntry("src/auth/codex/usage.ts: bad name!"),
    ).toBeDefined();
    expect(
      validateAllowlistEntry("src/auth/codex/usage.ts: 123abc"),
    ).toBeDefined();
    expect(validateAllowlistEntry("src/auth/codex/usage.ts:")).toBeDefined();
    expect(validateAllowlistEntry("usage.ts: fetchCodexUsage")).toBeDefined();
  });

  test("entries with whitespace fail", () => {
    expect(validateAllowlistEntry("src/has space/x.ts")).toBeDefined();
  });

  test("the checked-in allowlist passes shape validation", () => {
    const text = readFileSync(
      join(repoRoot, "scripts", "dead-export-allowlist.txt"),
      "utf8",
    );
    expect(validateAllowlistText(text)).toEqual([]);
  });
});

// This repo has no CODEOWNERS, so the documented review convention is that
// every entry block names its owning lane in the reason comment above it.
// The gate enforces the reason comments; human review enforces the lane.
describe("allowlist ownership", () => {
  test("an entry under a reason comment passes", () => {
    expect(
      validateAllowlistOwnership("# Owner: usage-data lane\nsrc/a.ts: Thing\n"),
    ).toEqual([]);
  });

  test("a reason block covers the contiguous entries below it", () => {
    expect(
      validateAllowlistOwnership(
        "# Owner: usage-data lane\nsrc/a.ts: Thing\nsrc/b.ts: Other\n",
      ),
    ).toEqual([]);
  });

  test("an entry with no reason comment fails", () => {
    expect(validateAllowlistOwnership("src/a.ts: Thing\n")).toEqual([
      "allowlist entry without a reason comment naming its owner: src/a.ts: Thing",
    ]);
  });

  test("a new section after a blank line needs its own reason", () => {
    expect(
      validateAllowlistOwnership(
        "# Owner: usage-data lane\nsrc/a.ts: Thing\n\nsrc/b.ts: Other\n",
      ),
    ).toEqual([
      "allowlist entry without a reason comment naming its owner: src/b.ts: Other",
    ]);
  });

  test("a bare hash is not a reason", () => {
    expect(validateAllowlistOwnership("#\nsrc/a.ts: Thing\n")).toEqual([
      "allowlist entry without a reason comment naming its owner: src/a.ts: Thing",
    ]);
  });

  test("the checked-in allowlist names an owner for every entry", () => {
    const text = readFileSync(
      join(repoRoot, "scripts", "dead-export-allowlist.txt"),
      "utf8",
    );
    expect(validateAllowlistOwnership(text)).toEqual([]);
  });
});

// The scan invocation is pinned to scripts/dead-export-guard.json so it never
// depends on ts-prune's working-directory config discovery, and the gate
// fails closed when the scanned file count drops below the checked-in floor
// instead of green-lighting a scan that looked at less code.
describe("pinned scan invocation", () => {
  test("the checked-in config pins the project and a positive floor", () => {
    const config = loadGuardConfig();
    expect(config.tsconfig).toBe("tsconfig.json");
    expect(config.tsPruneArgs).toEqual(["-p", "tsconfig.json"]);
    expect(config.minScannedFiles).toBeGreaterThan(0);
    expect(existsSync(join(repoRoot, config.tsconfig))).toBe(true);
  });

  test("parseGuardConfig rejects an unpinned or empty invocation", () => {
    const valid = {
      tsconfig: "tsconfig.json",
      tsPruneArgs: ["-p", "tsconfig.json"],
      minScannedFiles: 1130,
    };
    expect(parseGuardConfig(valid)).toEqual(valid);
    expect(() => parseGuardConfig({ ...valid, tsPruneArgs: [] })).toThrow();
    expect(() =>
      parseGuardConfig({ ...valid, tsPruneArgs: ["--ignore", "x"] }),
    ).toThrow();
    expect(() =>
      parseGuardConfig({
        ...valid,
        tsPruneArgs: ["-p", "tsconfig.other.json"],
      }),
    ).toThrow();
  });

  test("parseGuardConfig rejects extra narrowing flags on a pinned invocation", () => {
    const valid = {
      tsconfig: "tsconfig.json",
      tsPruneArgs: ["-p", "tsconfig.json"],
      minScannedFiles: 1130,
    };
    expect(parseGuardConfig(valid)).toEqual(valid);
    const narrowed = [
      ["-p", "tsconfig.json", "-i", "src/.*"],
      ["-p", "tsconfig.json", "--ignore", "src/.*"],
      ["-p", "tsconfig.json", "--error"],
      ["--ignore", "src/.*", "-p", "tsconfig.json"],
    ];
    for (const tsPruneArgs of narrowed) {
      expect(() => parseGuardConfig({ ...valid, tsPruneArgs })).toThrow();
    }
  });

  test("parseGuardConfig rejects a missing floor", () => {
    const valid = {
      tsconfig: "tsconfig.json",
      tsPruneArgs: ["-p", "tsconfig.json"],
      minScannedFiles: 1130,
    };
    for (const floor of [0, -5, 1.5, "1130", undefined]) {
      expect(() =>
        parseGuardConfig({ ...valid, minScannedFiles: floor }),
      ).toThrow();
    }
    expect(() => parseGuardConfig(null)).toThrow();
    expect(() => parseGuardConfig([])).toThrow();
  });
});

describe("scan coverage floor", () => {
  test("counts below the floor fail, counts at or above pass", () => {
    expect(isCoverageEnough(1129, 1130)).toBe(false);
    expect(isCoverageEnough(1130, 1130)).toBe(true);
    expect(isCoverageEnough(2000, 1130)).toBe(true);
  });

  test("the live program file count clears the checked-in floor", () => {
    const config = loadGuardConfig();
    const scanned = countScannedFiles(repoRoot, config.tsconfig);
    expect(scanned).toBeGreaterThanOrEqual(config.minScannedFiles);
  }, 120_000);

  test("the checked-in floor stays tight to the live count", () => {
    const config = loadGuardConfig();
    const scanned = countScannedFiles(repoRoot, config.tsconfig);
    expect(scanned).toBeLessThan(config.minScannedFiles * 1.1);
  }, 120_000);
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
  }, 120_000);
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
