/**
 * Pure helpers for the local capability eval suite (case load, grade, baseline compare).
 * Kept free of process.exit so unit tests can import it.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

export type EvalTier = "simple" | "complex";

export type EvalCase = {
  id: string;
  tier: EvalTier;
  title: string;
  /** Fixture path relative to the repository root. */
  fixture: string;
  prompt: string;
  maxTurns?: number;
  /** Grader filename relative to the case directory (default verify.sh). */
  verify: string;
  /** Absolute path to the case directory on disk. */
  caseDir: string;
};

export type CaseResult = {
  id: string;
  tier: EvalTier;
  title: string;
  passed: boolean;
  agentExitCode: number | null;
  verifyExitCode: number | null;
  durationMs: number;
  error: string | null;
  textPreview?: string;
};

export type EvalRunReport = {
  version: 1;
  startedAt: string;
  finishedAt: string;
  provider: string;
  model: string;
  cases: CaseResult[];
};

export type BaselineDelta = {
  id: string;
  previous: boolean | null;
  current: boolean;
  status: "improved" | "regressed" | "unchanged" | "new";
};

export type BaselineCompare = {
  deltas: BaselineDelta[];
  improved: number;
  regressed: number;
  unchanged: number;
  added: number;
};

const CASE_FILE = "case.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse and validate a case.json object; `caseDir` is attached by the loader. */
export function parseCaseJson(raw: unknown, caseDir: string): EvalCase {
  if (!isRecord(raw)) {
    throw new Error(`case.json must be an object (${caseDir})`);
  }
  const id = raw.id;
  const tier = raw.tier;
  const title = raw.title;
  const fixture = raw.fixture;
  const prompt = raw.prompt;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`case.json missing id (${caseDir})`);
  }
  if (tier !== "simple" && tier !== "complex") {
    throw new Error(`case ${id}: tier must be simple|complex`);
  }
  if (typeof title !== "string" || title.length === 0) {
    throw new Error(`case ${id}: missing title`);
  }
  if (typeof fixture !== "string" || fixture.length === 0) {
    throw new Error(`case ${id}: missing fixture`);
  }
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new Error(`case ${id}: missing prompt`);
  }
  const verify = typeof raw.verify === "string" && raw.verify.length > 0 ? raw.verify : "verify.sh";
  const maxTurns =
    typeof raw.maxTurns === "number" && Number.isFinite(raw.maxTurns) && raw.maxTurns > 0
      ? Math.floor(raw.maxTurns)
      : undefined;
  return {
    id,
    tier,
    title,
    fixture,
    prompt,
    verify,
    caseDir,
    ...(maxTurns !== undefined ? { maxTurns } : {}),
  };
}

/** Load every case under `casesRoot` (one subdirectory per case with case.json). */
export async function loadEvalCases(casesRoot: string): Promise<EvalCase[]> {
  const entries = await readdir(casesRoot, { withFileTypes: true });
  const cases: EvalCase[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const caseDir = join(casesRoot, entry.name);
    const casePath = join(caseDir, CASE_FILE);
    try {
      await stat(casePath);
    } catch {
      continue;
    }
    const text = await readFile(casePath, "utf8");
    const parsed: unknown = JSON.parse(text);
    const c = parseCaseJson(parsed, caseDir);
    if (c.id !== entry.name) {
      throw new Error(`case id "${c.id}" must match directory name "${entry.name}"`);
    }
    cases.push(c);
  }
  cases.sort((a, b) => a.id.localeCompare(b.id));
  return cases;
}

export function filterCases(cases: readonly EvalCase[], selector: string): EvalCase[] {
  if (selector === "all" || selector === "") return [...cases];
  const found = cases.filter((c) => c.id === selector);
  if (found.length === 0) {
    const known = cases.map((c) => c.id).join(", ") || "(none)";
    throw new Error(`Unknown case "${selector}". Known: ${known}`);
  }
  return found;
}

/** Absolute fixture path; rejects path escape outside repoRoot. */
export function resolveFixturePath(repoRoot: string, fixture: string): string {
  const root = resolve(repoRoot);
  const abs = resolve(root, fixture);
  if (abs !== root && !abs.startsWith(root + "/") && !abs.startsWith(root + "\\")) {
    throw new Error(`Fixture path escapes repository root: ${fixture}`);
  }
  return abs;
}

export function parseEvalRunReport(raw: unknown): EvalRunReport {
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.cases)) {
    throw new Error("Invalid eval report: expected version 1 with cases[]");
  }
  return raw as EvalRunReport;
}

/**
 * Compare current case results to a baseline report.
 * Missing baseline cases → `new`. Missing current cases are ignored (only current set is scored).
 */
export function compareToBaseline(
  current: readonly CaseResult[],
  baseline: EvalRunReport,
): BaselineCompare {
  const prevById = new Map(baseline.cases.map((c) => [c.id, c.passed]));
  const deltas: BaselineDelta[] = [];
  let improved = 0;
  let regressed = 0;
  let unchanged = 0;
  let added = 0;

  for (const c of current) {
    const prev = prevById.get(c.id);
    if (prev === undefined) {
      deltas.push({ id: c.id, previous: null, current: c.passed, status: "new" });
      added += 1;
      continue;
    }
    if (prev === c.passed) {
      deltas.push({ id: c.id, previous: prev, current: c.passed, status: "unchanged" });
      unchanged += 1;
    } else if (!prev && c.passed) {
      deltas.push({ id: c.id, previous: prev, current: c.passed, status: "improved" });
      improved += 1;
    } else {
      deltas.push({ id: c.id, previous: prev, current: c.passed, status: "regressed" });
      regressed += 1;
    }
  }

  return { deltas, improved, regressed, unchanged, added };
}

export function summarizeRun(cases: readonly CaseResult[]): {
  passed: number;
  failed: number;
  total: number;
} {
  const passed = cases.filter((c) => c.passed).length;
  return { passed, failed: cases.length - passed, total: cases.length };
}
