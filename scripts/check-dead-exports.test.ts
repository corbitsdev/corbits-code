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
  agentWorkspaceIds,
  countScannedFiles,
  evaluateGuard,
  isAllowlisted,
  isCoverageEnough,
  isGuardPassing,
  knipAgentProductionSpawn,
  agentsConfigPath,
  knipDefaultSpawn,
  loadAllowlist,
  loadGuardConfig,
  parseAllowlistText,
  parseGuardConfig,
  parseInjectedScannedFiles,
  parseKnipReport,
  validateAllowlistEntry,
  validateAllowlistOwnership,
  validateAllowlistText,
} from "./check-dead-exports.js";
import type { DeadExport } from "./check-dead-exports.js";

const repoRoot = join(import.meta.dir, "..");

// tsc --listFilesOnly costs ~1.5s; cache the deterministic count per process.
// The floor tests and the end-to-end probe share it, each computing on first
// use so no test depends on another having run.
let cachedScannedFileCount: number | undefined;
function liveScannedFileCount(): number {
  cachedScannedFileCount ??= countScannedFiles(
    repoRoot,
    loadGuardConfig().tsconfig,
  );
  return cachedScannedFileCount;
}

// Scoped exemptions cover only the named flags; a sibling probe still fails.
describe("scoped exemptions", () => {
  test("the real allowlist covers the named flags but not a sibling probe", () => {
    const rules = loadAllowlist();
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
    const outcome = evaluateGuard(rules, [
      { file: "src/auth/codex/usage.ts", name: "fetchCodexUsage" },
      { file: "src/auth/codex/usage.ts", name: "someNewDeadExport" },
    ]);
    expect(outcome.dead).toBe(2);
    expect(outcome.violations).toEqual([
      "src/auth/codex/usage.ts: someNewDeadExport",
    ]);
    expect(outcome.unused).toEqual([]);
  });

  test("the whole-unreachable-file finding matches a full-file allowlist entry", () => {
    const rules = parseAllowlistText(
      "evals/completion/tasks/x/fixture/data.ts\n",
    );
    const outcome = evaluateGuard(rules, [
      {
        file: "evals/completion/tasks/x/fixture/data.ts",
        name: "evals/completion/tasks/x/fixture/data.ts",
      },
    ]);
    expect(outcome.violations).toEqual([]);
    expect(outcome.unused).toEqual([]);
  });

  test("a vendor prefix covers every vendor finding regardless of count", () => {
    const rules = parseAllowlistText("vendor/\n");
    const outcome = evaluateGuard(rules, [
      { file: "vendor/intx-types/src/index.ts", name: "ErrorResponse" },
      { file: "vendor/intx-mime/src/whatever.ts", name: "SomethingElse" },
    ]);
    expect(outcome.violations).toEqual([]);
    expect(outcome.unused).toEqual([]);
    expect(isGuardPassing(outcome)).toBe(true);
  });
});

// knip's report parse: one place feeds the rule engine; a wrong shape must
// fail closed instead of silently narrowing the scan.
describe("knip report parsing", () => {
  test("exports, types, and members fold into (file, name) findings", () => {
    const report = JSON.stringify({
      issues: [
        {
          file: "src/a.ts",
          exports: [{ name: "alpha", line: 1, col: 14, pos: 13 }],
          types: [{ name: "AlphaShape", line: 2, col: 13, pos: 40 }],
          enumMembers: [],
          namespaceMembers: [],
          files: [],
        },
      ],
    });
    expect(parseKnipReport(report)).toEqual([
      { file: "src/a.ts", name: "alpha" },
      { file: "src/a.ts", name: "AlphaShape" },
    ]);
  });

  test("an unreachable file folds into one finding whose name is the path", () => {
    const report = JSON.stringify({
      issues: [
        {
          file: "evals/x/fixture/data.ts",
          exports: [],
          files: [{ name: "evals/x/fixture/data.ts" }],
        },
      ],
    });
    expect(parseKnipReport(report)).toEqual([
      { file: "evals/x/fixture/data.ts", name: "evals/x/fixture/data.ts" },
    ]);
  });

  test("issue classes outside the counted set are ignored", () => {
    const report = JSON.stringify({
      issues: [
        {
          file: "src/a.ts",
          dependencies: [{ name: "lodash" }],
          binaries: [{ name: "pgrep" }],
          duplicates: [[{ name: "dup" }]],
          exports: [{ name: "alpha" }],
        },
      ],
    });
    expect(parseKnipReport(report)).toEqual([
      { file: "src/a.ts", name: "alpha" },
    ]);
  });

  test("malformed reports fail closed", () => {
    expect(() => parseKnipReport("")).toThrow();
    expect(() => parseKnipReport("[]")).toThrow();
    expect(() => parseKnipReport("{}")).toThrow();
    expect(() => parseKnipReport('{"issues": [42]}')).toThrow();
    expect(() => parseKnipReport('{"issues": [{}]}')).toThrow();
    expect(() =>
      parseKnipReport('{"issues": [{"file": "a.ts", "exports": [{}]}]}'),
    ).toThrow();
    expect(() =>
      parseKnipReport('{"issues": [{"file": "a.ts", "files": [{}]}]}'),
    ).toThrow();
  });
});

// The guard semantics over findings shapes.
describe("guard evaluation", () => {
  const findings: readonly DeadExport[] = [
    { file: "vendor/intx-types/src/index.ts", name: "ErrorResponse" },
    { file: "src/auth/xai/usage.ts", name: "fetchXaiUsage" },
  ];

  test("a fully fresh allowlist passes the gate", () => {
    const rules = parseAllowlistText(
      "vendor/\nsrc/auth/xai/usage.ts: fetchXaiUsage\n",
    );
    const outcome = evaluateGuard(rules, findings);
    expect(outcome.violations).toEqual([]);
    expect(outcome.unused).toEqual([]);
    expect(isGuardPassing(outcome)).toBe(true);
  });

  test("violations fail the gate", () => {
    const outcome = evaluateGuard(
      [],
      [{ file: "src/new.ts", name: "freshDeadExport" }],
    );
    expect(outcome.violations).toEqual(["src/new.ts: freshDeadExport"]);
    expect(isGuardPassing(outcome)).toBe(false);
  });
});

// The knip semantics the guard depends on, run against the real repo:
//
// 1. In the default scan knip counts test-file imports as consumption, so an
//    export whose only importer is a test must NOT be reported there.
// 2. The production agent-workspace scan ignores test-file consumers, so the
//    six-name director surface's worker names surface again — including their
//    genuinely consumed siblings (registry.ts imports only `director`, and
//    src/agent/prompts.ts consumes dispatch's `systemPrompt`), which is the
//    test that catches a knip change silently restoring the laundering.
// 3. The allowlist covers the union so the gate stays green with the worker
//    names disclosed rather than silently absent.
describe("live knip scan semantics", () => {
  const knipBin = join(repoRoot, "node_modules", ".bin", "knip");

  test("default scan counts test-file consumers as alive (documented gap)", () => {
    const spawn = knipDefaultSpawn(knipBin);
    const ran = spawnSync(spawn.command, spawn.args, {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const findings = parseKnipReport(String(ran.stdout));
    const reported = (file: string, name: string): boolean =>
      findings.some((f) => f.file === file && f.name === name);

    // Exports used only inside their own module are not dead.
    expect(reported("src/inference-abort.ts", "InferenceAbortReason")).toBe(
      false,
    );
    // The director fan-in is a live consumer.
    expect(reported("agents/coder/src/index.ts", "director")).toBe(false);
    // knip counts the package contract test's import as consumption.
    expect(reported("agents/coder/src/index.ts", "tools")).toBe(false);
    // The ts-prune parser false positives are gone.
    expect(reported("src/agent/directors/identity.ts", "satisfies")).toBe(
      false,
    );
  }, 120_000);

  test("production agent scan removes test-file consumers from the surface", () => {
    const rules = loadAllowlist();
    const spawn = knipAgentProductionSpawn(knipBin, agentWorkspaceIds(rules));
    const ran = spawnSync(spawn.command, spawn.args, {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const findings = parseKnipReport(String(ran.stdout));
    const reported = (file: string, name: string): boolean =>
      findings.some((f) => f.file === file && f.name === name);

    for (const config of [
      "agents/coder",
      "agents/explorer",
      "agents/reviewer",
      "agents/planner",
      "agents/artist",
      "agents/prober",
      "agents/warden",
      "agents/designer",
      "agents/shakespeare",
      "agents/dispatch",
    ]) {
      const index = `${config}/src/index.ts`;
      // The laundered worker names resurface.
      expect(reported(index, "tools")).toBe(true);
      expect(reported(index, "config")).toBe(true);
      // dispatch's systemPrompt has a production consumer; the rest do not.
      if (config !== "agents/dispatch") {
        expect(reported(index, "systemPrompt")).toBe(true);
      }
      // The registry fan-in keeps its entry-file name alive.
      expect(reported(index, "director")).toBe(false);
      // The re-added allowlist entries match every surfaced finding.
      expect(isAllowlisted(rules, index, "tools")).toBe(true);
      expect(isAllowlisted(rules, index, "config")).toBe(true);
      expect(isAllowlisted(rules, `${config}/src/agent.ts`, "agent")).toBe(
        true,
      );
    }
    expect(reported("agents/dispatch/src/index.ts", "systemPrompt")).toBe(
      false,
    );
  }, 120_000);
});

// Stale entries (matching no current finding) fail the gate so the exemption
// dies with the code it covered; warn-only reporting let them linger.
describe("stale allowlist entries", () => {
  test("an entry matching nothing is reported as unused and fails the gate", () => {
    const rules = parseAllowlistText(
      "src/auth/xai/usage.ts: fetchXaiUsage\nsrc/gone.ts: vanishedExport\n",
    );
    const outcome = evaluateGuard(rules, [
      { file: "src/auth/xai/usage.ts", name: "fetchXaiUsage" },
    ]);
    expect(outcome.violations).toEqual([]);
    expect(outcome.unused).toEqual(["src/gone.ts: vanishedExport"]);
    expect(isGuardPassing(outcome)).toBe(false);
  });

  test("a prefix entry counts as used when any finding falls under it", () => {
    const rules = parseAllowlistText("vendor/\n");
    const outcome = evaluateGuard(rules, [
      { file: "vendor/intx-types/src/index.ts", name: "ErrorResponse" },
    ]);
    expect(outcome.violations).toEqual([]);
    expect(outcome.unused).toEqual([]);
    expect(isGuardPassing(outcome)).toBe(true);
  });
});

// Shapes the matcher would silently misinterpret must fail: a mistyped exact
// entry must not decay into a prefix, and a slash-less directory must not
// pass as an imprecise prefix.
describe("allowlist entry shapes", () => {
  test("valid entries pass", () => {
    expect(validateAllowlistEntry("vendor/")).toBeUndefined();
    expect(validateAllowlistEntry("src/auth/codex/usage.ts")).toBeUndefined();
    expect(
      validateAllowlistEntry("src/auth/codex/usage.ts: fetchCodexUsage"),
    ).toBeUndefined();
    expect(
      validateAllowlistEntry("fixtures/plugins/implement-feature/src/index.ts"),
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

// No CODEOWNERS here: each entry block names its owning lane in the reason
// comment above it. The gate enforces reasons; review enforces lanes.
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

// The scan invocation is pinned in code (reporter, flags, node runtime); the
// guard config cannot narrow it. The floor fails closed when the pinned
// tsconfig's program shrinks.
describe("pinned scan invocation", () => {
  test("the checked-in config pins the project and a positive floor", () => {
    const config = loadGuardConfig();
    expect(config.tsconfig).toBe("tsconfig.json");
    expect(config.minScannedFiles).toBeGreaterThan(0);
    expect(existsSync(join(repoRoot, config.tsconfig))).toBe(true);
  });

  test("the default scan runs with the pinned flags", () => {
    const spawn = knipDefaultSpawn("/repo/node_modules/.bin/knip");
    expect(spawn.command).toBe("node");
    expect(spawn.args).toEqual([
      "/repo/node_modules/.bin/knip",
      "--reporter",
      "json",
      "--no-progress",
      "--no-exit-code",
    ]);
  });

  test("the agent-workspace production scan is pinned per workspace", () => {
    const spawn = knipAgentProductionSpawn("/repo/node_modules/.bin/knip", [
      "agents/coder",
      "agents/dispatch",
    ]);
    expect(spawn.command).toBe("node");
    expect(spawn.args).toEqual([
      "/repo/node_modules/.bin/knip",
      "-c",
      agentsConfigPath(),
      "--production",
      "--reporter",
      "json",
      "--no-progress",
      "--no-exit-code",
      "-W",
      "agents/coder",
      "-W",
      "agents/dispatch",
    ]);
    expect(() => knipAgentProductionSpawn("/repo/x", [])).toThrow();
  });

  test("agent workspace ids derive from the allowlist and fail closed", () => {
    const rules = parseAllowlistText(
      "agents/coder/src/index.ts: agent\n" +
        "agents/coder/src/index.ts: agent\n" +
        "agents/dispatch/src/index.ts: agent\n" +
        "src/auth/codex/constants.ts: CODEX_REFRESH_SKEW_MS\n",
    );
    // Parse dedupes nothing at rule level; the derivation dedupes ids.
    expect(agentWorkspaceIds(rules)).toEqual([
      "agents/coder",
      "agents/dispatch",
    ]);
    expect(() => agentWorkspaceIds(parseAllowlistText("vendor/\n"))).toThrow();
  });

  test("parseGuardConfig rejects a missing tsconfig or floor and extra keys", () => {
    const valid = { tsconfig: "tsconfig.json", minScannedFiles: 1240 };
    expect(parseGuardConfig(valid)).toEqual(valid);
    expect(() => parseGuardConfig({ ...valid, minScannedFiles: 0 })).toThrow();
    expect(() => parseGuardConfig({ ...valid, tsconfig: "" })).toThrow();
    expect(() =>
      parseGuardConfig({ ...valid, tsPruneArgs: ["-p", "x"] }),
    ).toThrow();
    expect(() => parseGuardConfig(null)).toThrow();
    expect(() => parseGuardConfig([])).toThrow();
  });

  test("the scanned-files injection accepts no override or a positive integer", () => {
    expect(parseInjectedScannedFiles(undefined)).toBeUndefined();
    expect(parseInjectedScannedFiles("1217")).toBe(1217);
  });

  test("the scanned-files injection fails closed on a bogus value", () => {
    for (const bad of ["", "0", "-5", "1.5", "abc"]) {
      expect(() => parseInjectedScannedFiles(bad)).toThrow();
    }
  });
});

describe("scan coverage floor", () => {
  test("counts below the floor fail, counts at or above pass", () => {
    expect(isCoverageEnough(1239, 1240)).toBe(false);
    expect(isCoverageEnough(1240, 1240)).toBe(true);
    expect(isCoverageEnough(2000, 1240)).toBe(true);
  });

  test("the live program file count clears the checked-in floor", () => {
    const config = loadGuardConfig();
    expect(liveScannedFileCount()).toBeGreaterThanOrEqual(
      config.minScannedFiles,
    );
  }, 120_000);

  test("the checked-in floor stays tight to the live count", () => {
    const config = loadGuardConfig();
    expect(liveScannedFileCount()).toBeLessThan(config.minScannedFiles * 1.1);
  }, 120_000);
});

// Unit tests above prove the rule engine flags a probe; this one proves the
// wired-up gate does. A temp probe export lands in the knip-covered scripts/
// tree, the real guard runs as a subprocess, and the run must exit nonzero
// naming the probe. The probe lives only for the test so the keep-alive check
// cannot itself become a dead export; the injected count keeps the floor
// subprocess out of the timing.
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
        {
          cwd: repoRoot,
          encoding: "utf8",
          // Floor tests cover the file-count subprocess; inject the count so
          // this run pays only knip.
          env: {
            ...process.env,
            DEAD_EXPORT_GUARD_SCANNED_FILES: String(liveScannedFileCount()),
          },
        },
      );
      expect(ran.status).toBe(1);
      expect(`${ran.stdout}\n${ran.stderr}`).toContain(
        `${probeFile}: ${probeName}`,
      );
    } finally {
      rmSync(probePath, { force: true });
    }
  }, 240_000);
});

// A re-created barrel would silently resurrect a surface the purge removed.
// Pin the paths, not the file text.
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
  const roots = ["src", "e2e", "evals", "scripts", "fixtures", "packages"];

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
