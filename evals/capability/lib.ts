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

/** Token counters from the product run sink (mirrors TokenUsage shape). */
export type EvalTokenUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  thinking: number;
};

export const emptyTokenUsage = (): EvalTokenUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  thinking: 0,
});

/** One model/provider cell in a multi-variant matrix. */
export type EvalVariant = {
  /** Stable label for reports (defaults to provider/model). */
  id: string;
  provider?: string;
  model?: string;
};

export type CaseResult = {
  /** Stable key for baseline compare: variantId::caseId. */
  resultKey: string;
  id: string;
  tier: EvalTier;
  title: string;
  variantId: string;
  provider: string;
  model: string;
  passed: boolean;
  agentExitCode: number | null;
  verifyExitCode: number | null;
  /** Total wall time for the case (agent + verify + setup). */
  durationMs: number;
  agentDurationMs: number | null;
  verifyDurationMs: number | null;
  status: "done" | "failed" | "cancelled" | null;
  sessionId: string | null;
  turnsUsed: number | null;
  toolCallCount: number | null;
  tokenUsage: EvalTokenUsage | null;
  maxTurns: number | null;
  /** True when turnsUsed exceeded the configured maxTurns budget. */
  overBudget: boolean | null;
  skipPermissions: boolean;
  error: string | null;
  textPreview?: string;
};

export type EvalRunReport = {
  version: 2;
  startedAt: string;
  finishedAt: string;
  /** Primary / first variant (kept for human scanning). */
  provider: string;
  model: string;
  variants: EvalVariant[];
  cases: CaseResult[];
  totals: EvalRunTotals;
};

export type EvalRunTotals = {
  total: number;
  passed: number;
  failed: number;
  durationMs: number;
  turnsUsed: number;
  toolCallCount: number;
  tokenUsage: EvalTokenUsage;
};

export type BaselineDelta = {
  resultKey: string;
  id: string;
  variantId: string;
  previous: boolean | null;
  current: boolean;
  status: "improved" | "regressed" | "unchanged" | "new";
  /** Optional efficiency delta vs baseline when both runs tracked tokens/turns. */
  metrics?: {
    durationMsDelta: number | null;
    turnsUsedDelta: number | null;
    toolCallCountDelta: number | null;
    tokenOutputDelta: number | null;
  };
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
    const raw: unknown = JSON.parse(await readFile(casePath, "utf8"));
    const parsed = parseCaseJson(raw, caseDir);
    if (parsed.id !== entry.name) {
      throw new Error(
        `case id "${parsed.id}" must match directory name "${entry.name}" (${caseDir})`,
      );
    }
    cases.push(parsed);
  }
  cases.sort((a, b) => a.id.localeCompare(b.id));
  return cases;
}

/** Filter cases by id or "all". */
export function filterCases(cases: readonly EvalCase[], selector: string): EvalCase[] {
  if (selector === "all") return [...cases];
  const found = cases.filter((c) => c.id === selector);
  if (found.length === 0) {
    throw new Error(
      `Unknown case "${selector}". Available: ${cases.map((c) => c.id).join(", ") || "(none)"}`,
    );
  }
  return found;
}

export function resolveFixturePath(repoRoot: string, fixture: string): string {
  return resolve(repoRoot, fixture);
}

export function makeResultKey(variantId: string, caseId: string): string {
  return `${variantId}::${caseId}`;
}

export function defaultVariantId(provider?: string, model?: string): string {
  const p = provider ?? "default";
  const m = model ?? "default";
  return `${p}:${m}`;
}

/**
 * Parse a matrix string of variants.
 * Formats (comma-separated cells):
 *   - `provider:model`
 *   - `provider/model` (slash only when no colon)
 *   - `label=provider:model`
 * Empty / omitted → single default variant (caller provider/model flags).
 */
export function parseMatrix(
  matrix: string | undefined,
  fallback: { provider?: string; model?: string },
): EvalVariant[] {
  if (matrix === undefined || matrix.trim().length === 0) {
    const id = defaultVariantId(fallback.provider, fallback.model);
    return [
      {
        id,
        ...(fallback.provider !== undefined ? { provider: fallback.provider } : {}),
        ...(fallback.model !== undefined ? { model: fallback.model } : {}),
      },
    ];
  }
  const cells = matrix
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (cells.length === 0) {
    throw new Error("--matrix has no variants");
  }
  return cells.map((cell, index) => parseMatrixCell(cell, index));
}

function parseMatrixCell(cell: string, index: number): EvalVariant {
  let label: string | undefined;
  let rest = cell;
  const eq = cell.indexOf("=");
  if (eq > 0) {
    label = cell.slice(0, eq).trim();
    rest = cell.slice(eq + 1).trim();
  }
  let provider: string | undefined;
  let model: string | undefined;
  if (rest.includes(":")) {
    const [p, ...mParts] = rest.split(":");
    provider = p!.trim() || undefined;
    model = mParts.join(":").trim() || undefined;
  } else if (rest.includes("/")) {
    const [p, ...mParts] = rest.split("/");
    provider = p!.trim() || undefined;
    model = mParts.join("/").trim() || undefined;
  } else {
    throw new Error(
      `matrix cell ${index + 1} "${cell}" must be provider:model or label=provider:model`,
    );
  }
  if (provider === undefined && model === undefined) {
    throw new Error(`matrix cell ${index + 1} "${cell}" is empty`);
  }
  const id = label ?? defaultVariantId(provider, model);
  return {
    id,
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
  };
}

/** Cartesian product of cases × variants (cases outer for stable progress). */
export function expandMatrix(
  cases: readonly EvalCase[],
  variants: readonly EvalVariant[],
): Array<{ caseDef: EvalCase; variant: EvalVariant }> {
  const out: Array<{ caseDef: EvalCase; variant: EvalVariant }> = [];
  for (const caseDef of cases) {
    for (const variant of variants) {
      out.push({ caseDef, variant });
    }
  }
  return out;
}

export function addTokenUsage(a: EvalTokenUsage, b: EvalTokenUsage): EvalTokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    thinking: a.thinking + b.thinking,
  };
}

export function summarizeRun(results: readonly CaseResult[]): EvalRunTotals {
  let passed = 0;
  let durationMs = 0;
  let turnsUsed = 0;
  let toolCallCount = 0;
  let tokenUsage = emptyTokenUsage();
  for (const r of results) {
    if (r.passed) passed++;
    durationMs += r.durationMs;
    if (r.turnsUsed !== null) turnsUsed += r.turnsUsed;
    if (r.toolCallCount !== null) toolCallCount += r.toolCallCount;
    if (r.tokenUsage !== null) tokenUsage = addTokenUsage(tokenUsage, r.tokenUsage);
  }
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    durationMs,
    turnsUsed,
    toolCallCount,
    tokenUsage,
  };
}

function parseTokenUsage(raw: unknown): EvalTokenUsage | null {
  if (!isRecord(raw)) return null;
  const num = (k: string): number =>
    typeof raw[k] === "number" && Number.isFinite(raw[k] as number) ? (raw[k] as number) : 0;
  return {
    input: num("input"),
    output: num("output"),
    cacheRead: num("cacheRead"),
    cacheWrite: num("cacheWrite"),
    thinking: num("thinking"),
  };
}

function parseCaseResult(raw: unknown): CaseResult {
  if (!isRecord(raw)) throw new Error("case result must be an object");
  const id = raw.id;
  if (typeof id !== "string") throw new Error("case result missing id");
  const tier = raw.tier === "complex" ? "complex" : "simple";
  const title = typeof raw.title === "string" ? raw.title : id;
  const provider = typeof raw.provider === "string" ? raw.provider : "(unknown)";
  const model = typeof raw.model === "string" ? raw.model : "(unknown)";
  const variantId =
    typeof raw.variantId === "string" && raw.variantId.length > 0
      ? raw.variantId
      : defaultVariantId(provider, model);
  const resultKey =
    typeof raw.resultKey === "string" && raw.resultKey.length > 0
      ? raw.resultKey
      : makeResultKey(variantId, id);
  const status =
    raw.status === "done" || raw.status === "failed" || raw.status === "cancelled"
      ? raw.status
      : null;
  return {
    resultKey,
    id,
    tier,
    title,
    variantId,
    provider,
    model,
    passed: Boolean(raw.passed),
    agentExitCode: typeof raw.agentExitCode === "number" ? raw.agentExitCode : null,
    verifyExitCode: typeof raw.verifyExitCode === "number" ? raw.verifyExitCode : null,
    durationMs: typeof raw.durationMs === "number" ? raw.durationMs : 0,
    agentDurationMs: typeof raw.agentDurationMs === "number" ? raw.agentDurationMs : null,
    verifyDurationMs: typeof raw.verifyDurationMs === "number" ? raw.verifyDurationMs : null,
    status,
    sessionId: typeof raw.sessionId === "string" ? raw.sessionId : null,
    turnsUsed: typeof raw.turnsUsed === "number" ? raw.turnsUsed : null,
    toolCallCount: typeof raw.toolCallCount === "number" ? raw.toolCallCount : null,
    tokenUsage: parseTokenUsage(raw.tokenUsage),
    maxTurns: typeof raw.maxTurns === "number" ? raw.maxTurns : null,
    overBudget: typeof raw.overBudget === "boolean" ? raw.overBudget : null,
    skipPermissions: Boolean(raw.skipPermissions ?? true),
    error: typeof raw.error === "string" ? raw.error : raw.error === null ? null : null,
    ...(typeof raw.textPreview === "string" ? { textPreview: raw.textPreview } : {}),
  };
}

/** Validate a results JSON document (v1 or v2). */
export function parseEvalRunReport(raw: unknown): EvalRunReport {
  if (!isRecord(raw)) throw new Error("report must be an object");
  if (!Array.isArray(raw.cases)) throw new Error("report.cases must be an array");
  const cases = raw.cases.map(parseCaseResult);
  const provider = typeof raw.provider === "string" ? raw.provider : "(unknown)";
  const model = typeof raw.model === "string" ? raw.model : "(unknown)";
  const variants: EvalVariant[] = Array.isArray(raw.variants)
    ? raw.variants
        .filter(isRecord)
        .map((v, i) => {
          const id =
            typeof v.id === "string" && v.id.length > 0
              ? v.id
              : `variant-${i}`;
          return {
            id,
            ...(typeof v.provider === "string" ? { provider: v.provider } : {}),
            ...(typeof v.model === "string" ? { model: v.model } : {}),
          };
        })
    : [{ id: defaultVariantId(provider, model), provider, model }];
  const totals =
    isRecord(raw.totals) && typeof raw.totals.total === "number"
      ? {
          total: raw.totals.total as number,
          passed: typeof raw.totals.passed === "number" ? (raw.totals.passed as number) : 0,
          failed: typeof raw.totals.failed === "number" ? (raw.totals.failed as number) : 0,
          durationMs:
            typeof raw.totals.durationMs === "number" ? (raw.totals.durationMs as number) : 0,
          turnsUsed:
            typeof raw.totals.turnsUsed === "number" ? (raw.totals.turnsUsed as number) : 0,
          toolCallCount:
            typeof raw.totals.toolCallCount === "number"
              ? (raw.totals.toolCallCount as number)
              : 0,
          tokenUsage: parseTokenUsage(raw.totals.tokenUsage) ?? emptyTokenUsage(),
        }
      : summarizeRun(cases);
  return {
    version: 2,
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : "",
    finishedAt: typeof raw.finishedAt === "string" ? raw.finishedAt : "",
    provider,
    model,
    variants,
    cases,
    totals,
  };
}

export function compareToBaseline(
  current: readonly CaseResult[],
  baseline: EvalRunReport,
): BaselineCompare {
  const prevByKey = new Map(baseline.cases.map((c) => [c.resultKey, c]));
  // Also index v1-style id-only for partial matches when variant missing.
  const prevById = new Map(baseline.cases.map((c) => [c.id, c]));
  const deltas: BaselineDelta[] = [];
  let improved = 0;
  let regressed = 0;
  let unchanged = 0;
  let added = 0;

  for (const cur of current) {
    const prev = prevByKey.get(cur.resultKey) ?? (
      // Fallback: same case id when baseline had a single default variant.
      baseline.cases.length > 0 && baseline.variants.length <= 1
        ? prevById.get(cur.id)
        : undefined
    );
    if (prev === undefined) {
      deltas.push({
        resultKey: cur.resultKey,
        id: cur.id,
        variantId: cur.variantId,
        previous: null,
        current: cur.passed,
        status: "new",
      });
      added++;
      continue;
    }
    let status: BaselineDelta["status"];
    if (prev.passed === cur.passed) {
      status = "unchanged";
      unchanged++;
    } else if (!prev.passed && cur.passed) {
      status = "improved";
      improved++;
    } else {
      status = "regressed";
      regressed++;
    }
    const numDelta = (a: number | null, b: number | null): number | null =>
      a !== null && b !== null ? b - a : null;
    deltas.push({
      resultKey: cur.resultKey,
      id: cur.id,
      variantId: cur.variantId,
      previous: prev.passed,
      current: cur.passed,
      status,
      metrics: {
        durationMsDelta: numDelta(prev.durationMs, cur.durationMs),
        turnsUsedDelta: numDelta(prev.turnsUsed, cur.turnsUsed),
        toolCallCountDelta: numDelta(prev.toolCallCount, cur.toolCallCount),
        tokenOutputDelta: numDelta(
          prev.tokenUsage?.output ?? null,
          cur.tokenUsage?.output ?? null,
        ),
      },
    });
  }

  return { deltas, improved, regressed, unchanged, added };
}
