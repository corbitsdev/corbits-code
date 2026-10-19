/**
 * Compares one run of the session-store perf scripts to the checked-in
 * baseline. Both scripts patch fs.promises only, so synchronous fs is
 * invisible and this gate does not claim to see it.
 *
 * `.git` mkdir and writeFile move with isomorphic-git object-id fanout
 * (commit timestamps). Every other counted op is exact. Wall time is ignored.
 *
 * Usage:
 *   bun scripts/check-session-store-perf-baseline.ts \
 *     scripts/results/session-store-perf-baseline.json \
 *     <context-store-perf.json> \
 *     <turn-persistence-census.json>
 */
import { readFileSync } from "node:fs";
import { type } from "arktype";

/** Absolute slack on every counted op that is not git object-dir fanout. */
export const COUNTED_OP_TOLERANCE = 0;
/**
 * Absolute slack on `.git` mkdir and writeFile. Five local runs and one
 * linux run stayed within 13 of each other; 64 still fails a per-turn write.
 */
export const GIT_FANOUT_TOLERANCE = 64;

const GIT_FANOUT_OPS = new Set(["mkdir", "writeFile"]);

const CountMap = type({ "[string]": "number.integer>=0" });

const PerfMeasurement = type({
  turnCount: "number.integer>=1",
  loadedTurns: "number.integer>=0",
  fsOps: CountMap,
  gitPathFsOpsByName: CountMap,
}).onUndeclaredKey("delete");

const CensusMeasurement = type({
  flow: "'coalesced' | 'legacy'",
  turnCount: "number.integer>=1",
  loadedTurns: "number.integer>=0",
  byName: CountMap,
  gitByPath: CountMap,
  persistCalls: CountMap,
}).onUndeclaredKey("delete");

const BaselineFile = type({
  tolerance: {
    countedOp: "0",
    gitFanoutMkdirAndWriteFile: "64",
  },
  commands: "string[]",
  contextStorePerf: PerfMeasurement,
  turnPersistenceCensus: CensusMeasurement,
}).onUndeclaredKey("delete");

export type PerfMeasurement = typeof PerfMeasurement.infer;
export type CensusMeasurement = typeof CensusMeasurement.infer;
export type BaselineFile = typeof BaselineFile.infer;

const PERF_COMMAND = "bun scripts/context-store-perf.ts 200 --json";
const CENSUS_COMMAND =
  "bun scripts/turn-persistence-census.ts 200 --flow=coalesced --json";

function failCount(
  label: string,
  expected: number,
  actual: number,
  tolerance: number,
): string | undefined {
  const delta = Math.abs(actual - expected);
  if (delta <= tolerance) return undefined;
  return `${label}: expected ${expected} ± ${tolerance}, got ${actual} (delta ${delta})`;
}

export function compareCountMaps(
  label: string,
  baselineOps: Record<string, number>,
  actualOps: Record<string, number>,
  baselineGit: Record<string, number>,
  actualGit: Record<string, number>,
): string[] {
  const keys = new Set([
    ...Object.keys(baselineOps),
    ...Object.keys(actualOps),
    ...Object.keys(baselineGit),
    ...Object.keys(actualGit),
  ]);
  const failures: string[] = [];
  for (const key of [...keys].sort()) {
    const base = baselineOps[key] ?? 0;
    const actual = actualOps[key] ?? 0;
    const baseGitCount = baselineGit[key] ?? 0;
    const actualGitCount = actualGit[key] ?? 0;
    const outsideGit = failCount(
      `${label} ${key} outside .git`,
      base - baseGitCount,
      actual - actualGitCount,
      COUNTED_OP_TOLERANCE,
    );
    if (outsideGit !== undefined) failures.push(outsideGit);
    const gitTolerance = GIT_FANOUT_OPS.has(key)
      ? GIT_FANOUT_TOLERANCE
      : COUNTED_OP_TOLERANCE;
    const git = failCount(
      `${label} .git ${key}`,
      baseGitCount,
      actualGitCount,
      gitTolerance,
    );
    if (git !== undefined) failures.push(git);
  }
  return failures;
}

function compareExactMap(
  label: string,
  baseline: Record<string, number>,
  actual: Record<string, number>,
): string[] {
  const keys = new Set([...Object.keys(baseline), ...Object.keys(actual)]);
  const failures: string[] = [];
  for (const key of [...keys].sort()) {
    const mismatch = failCount(
      `${label} ${key}`,
      baseline[key] ?? 0,
      actual[key] ?? 0,
      COUNTED_OP_TOLERANCE,
    );
    if (mismatch !== undefined) failures.push(mismatch);
  }
  return failures;
}

export function gateSessionStoreBaseline(
  baseline: BaselineFile,
  perf: PerfMeasurement,
  census: CensusMeasurement,
): string[] {
  const failures: string[] = [];
  if (!baseline.commands.includes(PERF_COMMAND)) {
    failures.push(`baseline commands missing ${PERF_COMMAND}`);
  }
  if (!baseline.commands.includes(CENSUS_COMMAND)) {
    failures.push(`baseline commands missing ${CENSUS_COMMAND}`);
  }
  if (
    baseline.tolerance.countedOp !== COUNTED_OP_TOLERANCE ||
    baseline.tolerance.gitFanoutMkdirAndWriteFile !== GIT_FANOUT_TOLERANCE
  ) {
    failures.push(
      `baseline tolerance must be countedOp ${COUNTED_OP_TOLERANCE} and gitFanoutMkdirAndWriteFile ${GIT_FANOUT_TOLERANCE}`,
    );
  }
  if (perf.turnCount !== baseline.contextStorePerf.turnCount) {
    failures.push(
      `context-store-perf turnCount: expected ${baseline.contextStorePerf.turnCount}, got ${perf.turnCount}`,
    );
  }
  if (perf.loadedTurns !== baseline.contextStorePerf.loadedTurns) {
    failures.push(
      `context-store-perf loadedTurns: expected ${baseline.contextStorePerf.loadedTurns}, got ${perf.loadedTurns}`,
    );
  }
  failures.push(
    ...compareCountMaps(
      "context-store-perf",
      baseline.contextStorePerf.fsOps,
      perf.fsOps,
      baseline.contextStorePerf.gitPathFsOpsByName,
      perf.gitPathFsOpsByName,
    ),
  );
  if (census.flow !== baseline.turnPersistenceCensus.flow) {
    failures.push(
      `turn-persistence-census flow: expected ${baseline.turnPersistenceCensus.flow}, got ${census.flow}`,
    );
  }
  if (census.turnCount !== baseline.turnPersistenceCensus.turnCount) {
    failures.push(
      `turn-persistence-census turnCount: expected ${baseline.turnPersistenceCensus.turnCount}, got ${census.turnCount}`,
    );
  }
  if (census.loadedTurns !== baseline.turnPersistenceCensus.loadedTurns) {
    failures.push(
      `turn-persistence-census loadedTurns: expected ${baseline.turnPersistenceCensus.loadedTurns}, got ${census.loadedTurns}`,
    );
  }
  failures.push(
    ...compareCountMaps(
      "turn-persistence-census",
      baseline.turnPersistenceCensus.byName,
      census.byName,
      baseline.turnPersistenceCensus.gitByPath,
      census.gitByPath,
    ),
  );
  failures.push(
    ...compareExactMap(
      "turn-persistence-census persistCalls",
      baseline.turnPersistenceCensus.persistCalls,
      census.persistCalls,
    ),
  );
  return failures;
}

function parse<T>(
  schema: (data: unknown) => T | type.errors,
  raw: string,
  label: string,
): T {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`${label} is not JSON`, { cause });
  }
  const parsed = schema(json);
  if (parsed instanceof type.errors) {
    throw new Error(`${label}: ${parsed.summary}`);
  }
  return parsed;
}

export function gateSessionStoreBaselineJson(
  baselineRaw: string,
  perfRaw: string,
  censusRaw: string,
): string[] {
  return gateSessionStoreBaseline(
    parse(BaselineFile, baselineRaw, "baseline"),
    parse(PerfMeasurement, perfRaw, "context-store-perf"),
    parse(CensusMeasurement, censusRaw, "turn-persistence-census"),
  );
}

function main(argv: string[]): number {
  const baselinePath = argv[2];
  const perfPath = argv[3];
  const censusPath = argv[4];
  if (
    baselinePath === undefined ||
    perfPath === undefined ||
    censusPath === undefined
  ) {
    console.error(
      "usage: bun scripts/check-session-store-perf-baseline.ts <baseline.json> <context-store-perf.json> <turn-persistence-census.json>",
    );
    return 1;
  }
  try {
    const failures = gateSessionStoreBaselineJson(
      readFileSync(baselinePath, "utf8"),
      readFileSync(perfPath, "utf8"),
      readFileSync(censusPath, "utf8"),
    );
    if (failures.length === 0) return 0;
    for (const failure of failures) console.error(failure);
    return 1;
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    return 1;
  }
}

if (import.meta.main) {
  process.exit(main(process.argv));
}
