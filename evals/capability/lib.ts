/**
 * Pure helpers for the capability eval suite (case load, grade, baseline compare).
 * No process.exit so unit tests can import it.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type } from "arktype";
import {
  runWithEvalHttpEnv,
  evalHttpEnvGet,
} from "../../src/tools/eval-http-env.js";
import {
  isReasoningEffort,
  type ReasoningEffort,
} from "../../src/provider/reasoning-effort.js";
import {
  isNumericBehaviorMetric,
  parseBehaviorMetrics,
  BEHAVIOR_METRIC_DIRECTIONS,
  NUMERIC_BEHAVIOR_METRICS,
  type BehaviorMetrics,
  type NumericBehaviorMetric,
} from "./behaviors.js";

/** Difficulty tiers with target pass bands; saturated cases are promoted or retired. */
export type EvalTier = "easy" | "med" | "hard" | "xhard";

export const EVAL_TIERS: readonly EvalTier[] = ["easy", "med", "hard", "xhard"];

function isEvalTier(value: string): value is EvalTier {
  return EVAL_TIERS.includes(value as EvalTier);
}

/** Case reproducing a known misbehavior: aggregate median of `metric` above `threshold`. */
export interface EvalBait {
  metric: NumericBehaviorMetric;
  threshold: number;
}

/** Hard bound on a captured behavior metric: case fails when outside [min, max]. */
export interface BehaviorRequirement {
  metric: NumericBehaviorMetric;
  min?: number;
  max?: number;
  /** Omitted means all directors; default runs use Dispatch. */
  directors?: string[];
}

export interface EvalCase {
  id: string;
  tier: EvalTier;
  title: string;
  /** Fixture path relative to the repository root. */
  fixture: string;
  prompt: string;
  /** Grader filename relative to the case directory (default verify.sh). */
  verify: string;
  /** Absolute path to the case directory on disk. */
  caseDir: string;
  bait?: EvalBait;
  /** Runner serves a hermetic local HTTP page and substitutes `{{HTTP_URL}}` in the prompt. */
  httpFixture?: boolean;
  /** Honesty bounds on captured metrics: fail the case even when exit and verify pass. */
  requireBehaviors?: BehaviorRequirement[];
}

/** Token counters from the product run sink (mirrors TokenUsage shape). */
export interface EvalTokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  thinking: number;
}

export const emptyTokenUsage = (): EvalTokenUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  thinking: 0,
});

/** One model/provider cell in a multi-variant matrix. */
export interface EvalVariant {
  /** Stable label for reports (defaults to provider/model). */
  id: string;
  provider?: string;
  model?: string;
  /** Reasoning effort for this cell; overrides the run-level --effort. */
  effort?: ReasoningEffort;
}

/**
 * Resolved provider/model differs from what the cell requested (matrix cell
 * or CLI flags) — e.g. a silent fallback kicked in.
 */
export interface ProviderFallbackInfo {
  requestedProvider: string | null;
  requestedModel: string | null;
  resolvedProvider: string;
  resolvedModel: string;
}

export interface CaseResult {
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
  skipPermissions: boolean;
  error: string | null;
  /** 0-based repeat index within the case×variant cell. */
  repeat: number;
  /** Behavior metrics derived from the turn stream; null when capture failed. */
  behaviors: BehaviorMetrics | null;
  /** Set when the resolved provider/model differed from what was requested. */
  providerFallback: ProviderFallbackInfo | null;
  /** Per-cell diagnostics for debugging eval failures; null when unavailable. */
  diagnostics: EvalDiagnostics | null;
  /** Requested reasoning effort for this cell (--effort or matrix cell); null when unset. */
  effort: ReasoningEffort | null;
  textPreview?: string;
}

export interface EvalDiagnostics {
  /** Built-in tool names advertised to the model for this run. */
  advertisedTools: readonly string[];
  reasoningEffort: string | null;
}

export interface MetricStats {
  min: number;
  median: number;
  max: number;
}

/** Per case×variant cell aggregate across repeats. */
export interface CellAggregate {
  resultKey: string;
  id: string;
  variantId: string;
  /** Resolved provider/model actually used (from the cell's first repeat). */
  provider: string;
  model: string;
  repeats: number;
  passCount: number;
  passRate: number;
  /** min/median/max per numeric behavior metric, over repeats with behaviors. */
  behaviorStats: Partial<Record<NumericBehaviorMetric, MetricStats>>;
}

export interface EvalRunReport {
  version: 3;
  startedAt: string;
  finishedAt: string;
  /** Primary / first variant (kept for human scanning). */
  provider: string;
  model: string;
  /** Repeats per case×variant cell. */
  repeats: number;
  variants: EvalVariant[];
  cases: CaseResult[];
  aggregates: CellAggregate[];
  totals: EvalRunTotals;
}

export interface EvalRunTotals {
  total: number;
  passed: number;
  failed: number;
  durationMs: number;
  turnsUsed: number;
  toolCallCount: number;
  tokenUsage: EvalTokenUsage;
}

export interface BehaviorVerdict {
  metric: NumericBehaviorMetric;
  baselineMedian: number;
  currentMedian: number;
  /** Directional verdict; "neutral" for informational metrics or no change. */
  verdict: "improve" | "regress" | "neutral";
}

export interface BaselineDelta {
  resultKey: string;
  id: string;
  variantId: string;
  /** null when the cell is new relative to the baseline. */
  previousPassRate: number | null;
  currentPassRate: number;
  /** Any pass-rate change is significant. */
  status: "improved" | "regressed" | "unchanged" | "new";
  /** Behavior-metric verdicts on medians, present when both runs captured behaviors. */
  behaviorVerdicts: BehaviorVerdict[];
  /** Set when the case is a bait whose baseline does not reproduce its misbehavior. */
  baitNotReproducing?: string;
}

export interface BaselineCompare {
  deltas: BaselineDelta[];
  improved: number;
  regressed: number;
  unchanged: number;
  added: number;
  behaviorImproved: number;
  behaviorRegressed: number;
  baitFlags: number;
}

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
  if (typeof tier !== "string" || !isEvalTier(tier)) {
    throw new Error(`case ${id}: tier must be ${EVAL_TIERS.join("|")}`);
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
  const verify =
    typeof raw.verify === "string" && raw.verify.length > 0
      ? raw.verify
      : "verify.sh";
  const bait = parseBait(raw.bait, id);
  const httpFixture = raw.httpFixture === true ? true : undefined;
  const requireBehaviors = parseRequireBehaviors(raw.requireBehaviors, id);
  return {
    id,
    tier,
    title,
    fixture,
    prompt,
    verify,
    caseDir,
    ...(bait !== undefined ? { bait } : {}),
    ...(httpFixture !== undefined ? { httpFixture } : {}),
    ...(requireBehaviors !== undefined ? { requireBehaviors } : {}),
  };
}

function parseBait(raw: unknown, caseId: string): EvalBait | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) {
    throw new Error(`case ${caseId}: bait must be an object`);
  }
  const metric = raw.metric;
  const threshold = raw.threshold;
  if (typeof metric !== "string" || !isNumericBehaviorMetric(metric)) {
    throw new Error(
      `case ${caseId}: bait.metric must be one of ${NUMERIC_BEHAVIOR_METRICS.join(", ")}`,
    );
  }
  if (
    typeof threshold !== "number" ||
    !Number.isFinite(threshold) ||
    threshold < 0
  ) {
    throw new Error(
      `case ${caseId}: bait.threshold must be a non-negative number`,
    );
  }
  return { metric, threshold };
}

function parseRequireBehaviors(
  raw: unknown,
  caseId: string,
): BehaviorRequirement[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(`case ${caseId}: requireBehaviors must be an array`);
  }
  if (raw.length === 0) {
    throw new Error(
      `case ${caseId}: requireBehaviors must be non-empty when present`,
    );
  }
  return raw.map((entry, index) =>
    parseBehaviorRequirement(entry, caseId, index),
  );
}

function parseBehaviorRequirement(
  raw: unknown,
  caseId: string,
  index: number,
): BehaviorRequirement {
  const label = `case ${caseId}: requireBehaviors[${index}]`;
  if (!isRecord(raw)) {
    throw new Error(`${label} must be an object`);
  }
  const metric = raw.metric;
  if (typeof metric !== "string" || !isNumericBehaviorMetric(metric)) {
    throw new Error(
      `${label}.metric must be one of ${NUMERIC_BEHAVIOR_METRICS.join(", ")}`,
    );
  }
  const hasMin = raw.min !== undefined;
  const hasMax = raw.max !== undefined;
  if (!hasMin && !hasMax) {
    throw new Error(`${label} must set at least one of min or max`);
  }
  let min: number | undefined;
  let max: number | undefined;
  if (hasMin) {
    if (
      typeof raw.min !== "number" ||
      !Number.isFinite(raw.min) ||
      raw.min < 0
    ) {
      throw new Error(`${label}.min must be a non-negative number`);
    }
    min = raw.min;
  }
  if (hasMax) {
    if (
      typeof raw.max !== "number" ||
      !Number.isFinite(raw.max) ||
      raw.max < 0
    ) {
      throw new Error(`${label}.max must be a non-negative number`);
    }
    max = raw.max;
  }
  if (min !== undefined && max !== undefined && min > max) {
    throw new Error(`${label}: min (${min}) must be <= max (${max})`);
  }
  let directors: string[] | undefined;
  if (raw.directors !== undefined) {
    const parsed = type("string[]")(raw.directors);
    if (parsed instanceof type.errors || parsed.length === 0) {
      throw new Error(`${label}.directors must be a non-empty string array`);
    }
    directors = parsed;
  }
  return {
    metric,
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(directors !== undefined ? { directors } : {}),
  };
}

/** Check captured behavior metrics against case bounds; fails closed when capture is missing. */
export function checkBehaviorRequirements(
  behaviors: BehaviorMetrics | null,
  reqs: readonly BehaviorRequirement[],
  director = "dispatch",
): { ok: boolean; failures: string[] } {
  const applicable = reqs.filter(
    (req) => req.directors === undefined || req.directors.includes(director),
  );
  if (applicable.length === 0) return { ok: true, failures: [] };
  if (behaviors === null) {
    return {
      ok: false,
      failures: [
        "requireBehaviors set but behavior capture missing (no turn stream recorded)",
      ],
    };
  }
  const failures: string[] = [];
  for (const req of applicable) {
    const value = behaviors[req.metric];
    if (req.min !== undefined && value < req.min) {
      failures.push(`${req.metric}=${value} below min ${req.min}`);
    }
    if (req.max !== undefined && value > req.max) {
      failures.push(`${req.metric}=${value} above max ${req.max}`);
    }
  }
  return { ok: failures.length === 0, failures };
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
export function filterCases(
  cases: readonly EvalCase[],
  selector: string,
): EvalCase[] {
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

export { evalHttpEnvGet, runWithEvalHttpEnv };

/**
 * Env vars for the eval-only SSRF fixture exception (src/tools/ssrf-guard.ts):
 * EVAL_HTTP_URL for the agent, EVAL_HTTP_TOKEN for verify.sh.
 */
export function httpFixtureEnv(fixture: {
  url: string;
  token: string;
}): Record<string, string> {
  return { EVAL_HTTP_URL: fixture.url, EVAL_HTTP_TOKEN: fixture.token };
}

/**
 * Runs `fn` with `vars` isolated via async context so concurrent cells never
 * clobber each other's overlay; process.env stays untouched.
 */
export async function withEnv<T>(
  vars: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  return runWithEvalHttpEnv(vars, fn);
}

/**
 * What the cell actually requested: the variant's own override, else the
 * run's resolved labels. Ambient-default runs would otherwise skip the
 * mismatch check; "(default)" means absent.
 */
export function resolveRequestedProviderModel(
  variant: { provider?: string; model?: string },
  labels: { provider?: string; model?: string },
): { provider?: string; model?: string } {
  const requested = (v?: string): string | undefined =>
    v === undefined || v === "(default)" ? undefined : v;
  const provider = variant.provider ?? requested(labels.provider);
  const model = variant.model ?? requested(labels.model);
  return {
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
  };
}

/** Compare requested vs resolved provider/model; null when they match or nothing was requested. */
export function detectProviderFallback(args: {
  requestedProvider?: string;
  requestedModel?: string;
  resolvedProvider: string;
  resolvedModel: string;
}): ProviderFallbackInfo | null {
  const providerMismatch =
    args.requestedProvider !== undefined &&
    args.requestedProvider !== args.resolvedProvider;
  const modelMismatch =
    args.requestedModel !== undefined &&
    args.requestedModel !== args.resolvedModel;
  if (!providerMismatch && !modelMismatch) return null;
  return {
    requestedProvider: args.requestedProvider ?? null,
    requestedModel: args.requestedModel ?? null,
    resolvedProvider: args.resolvedProvider,
    resolvedModel: args.resolvedModel,
  };
}

export function formatProviderFallback(info: ProviderFallbackInfo): string {
  const requested = `${info.requestedProvider ?? "(default)"}/${info.requestedModel ?? "(default)"}`;
  const resolved = `${info.resolvedProvider}/${info.resolvedModel}`;
  return `provider/model mismatch: requested ${requested} but resolved to ${resolved}`;
}

export function defaultVariantId(provider?: string, model?: string): string {
  const p = provider ?? "default";
  const m = model ?? "default";
  return `${p}:${m}`;
}

/**
 * Parse a comma-separated matrix string: `provider:model[:effort]`,
 * `provider/model`, or `label=...`. Empty → a single default variant from
 * the caller's flags; missing sides fill from `--provider`/`--model`.
 */
export function parseMatrix(
  matrix: string | undefined,
  fallback: { provider?: string; model?: string; effort?: ReasoningEffort },
): EvalVariant[] {
  if (matrix === undefined || matrix.trim().length === 0) {
    const id = defaultVariantId(fallback.provider, fallback.model);
    return [
      {
        id,
        ...(fallback.provider !== undefined
          ? { provider: fallback.provider }
          : {}),
        ...(fallback.model !== undefined ? { model: fallback.model } : {}),
        ...(fallback.effort !== undefined ? { effort: fallback.effort } : {}),
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
  return cells.map((cell, index) => parseMatrixCell(cell, index, fallback));
}

function parseMatrixCell(
  cell: string,
  index: number,
  fallback: { provider?: string; model?: string; effort?: ReasoningEffort },
): EvalVariant {
  let label: string | undefined;
  let rest = cell;
  const eq = cell.indexOf("=");
  if (eq > 0) {
    label = cell.slice(0, eq).trim();
    rest = cell.slice(eq + 1).trim();
  }
  let provider: string | undefined;
  let model: string | undefined;
  let effort: ReasoningEffort | undefined;
  if (rest.includes(":")) {
    const parts = rest.split(":");
    // The last segment is effort only when it parses as a reasoning-effort literal.
    const last = parts.at(-1);
    if (parts.length >= 3 && last !== undefined) {
      const trimmedLast = last.trim();
      if (isReasoningEffort(trimmedLast)) {
        effort = trimmedLast;
        parts.pop();
      }
    }
    const [p, ...mParts] = parts;
    if (p === undefined) {
      throw new Error(
        `matrix cell ${index + 1} "${cell}" must be provider:model or label=provider:model`,
      );
    }
    provider = p.trim() || undefined;
    model = mParts.join(":").trim() || undefined;
  } else if (rest.includes("/")) {
    const [p, ...mParts] = rest.split("/");
    if (p === undefined) {
      throw new Error(
        `matrix cell ${index + 1} "${cell}" must be provider:model or label=provider:model`,
      );
    }
    provider = p.trim() || undefined;
    model = mParts.join("/").trim() || undefined;
  } else {
    throw new Error(
      `matrix cell ${index + 1} "${cell}" must be provider:model or label=provider:model`,
    );
  }
  provider = provider ?? fallback.provider;
  model = model ?? fallback.model;
  effort = effort ?? fallback.effort;
  if (provider === undefined || model === undefined) {
    throw new Error(
      `matrix cell ${index + 1} "${cell}" must specify both provider and model`,
    );
  }
  const id = label ?? defaultVariantId(provider, model);
  return { id, provider, model, ...(effort !== undefined ? { effort } : {}) };
}

/** Cartesian product of cases × variants (cases outer for stable progress). */
export function expandMatrix(
  cases: readonly EvalCase[],
  variants: readonly EvalVariant[],
): { caseDef: EvalCase; variant: EvalVariant }[] {
  const out: { caseDef: EvalCase; variant: EvalVariant }[] = [];
  for (const caseDef of cases) {
    for (const variant of variants) {
      out.push({ caseDef, variant });
    }
  }
  return out;
}

export function addTokenUsage(
  a: EvalTokenUsage,
  b: EvalTokenUsage,
): EvalTokenUsage {
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
    if (r.tokenUsage !== null)
      tokenUsage = addTokenUsage(tokenUsage, r.tokenUsage);
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
    typeof raw[k] === "number" && Number.isFinite(raw[k] as number)
      ? (raw[k] as number)
      : 0;
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
  const tier: EvalTier = EVAL_TIERS.includes(raw.tier as EvalTier)
    ? (raw.tier as EvalTier)
    : "med";
  const title = typeof raw.title === "string" ? raw.title : id;
  const provider =
    typeof raw.provider === "string" ? raw.provider : "(unknown)";
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
    raw.status === "done" ||
    raw.status === "failed" ||
    raw.status === "cancelled"
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
    agentExitCode:
      typeof raw.agentExitCode === "number" ? raw.agentExitCode : null,
    verifyExitCode:
      typeof raw.verifyExitCode === "number" ? raw.verifyExitCode : null,
    durationMs: typeof raw.durationMs === "number" ? raw.durationMs : 0,
    agentDurationMs:
      typeof raw.agentDurationMs === "number" ? raw.agentDurationMs : null,
    verifyDurationMs:
      typeof raw.verifyDurationMs === "number" ? raw.verifyDurationMs : null,
    status,
    sessionId: typeof raw.sessionId === "string" ? raw.sessionId : null,
    turnsUsed: typeof raw.turnsUsed === "number" ? raw.turnsUsed : null,
    toolCallCount:
      typeof raw.toolCallCount === "number" ? raw.toolCallCount : null,
    tokenUsage: parseTokenUsage(raw.tokenUsage),
    skipPermissions: Boolean(raw.skipPermissions ?? true),
    error:
      typeof raw.error === "string"
        ? raw.error
        : raw.error === null
          ? null
          : null,
    repeat:
      typeof raw.repeat === "number" &&
      Number.isInteger(raw.repeat) &&
      raw.repeat >= 0
        ? raw.repeat
        : 0,
    behaviors: parseBehaviorMetrics(raw.behaviors),
    providerFallback: parseProviderFallback(raw.providerFallback),
    diagnostics: parseEvalDiagnostics(raw.diagnostics),
    effort: isReasoningEffort(raw.effort) ? raw.effort : null,
    ...(typeof raw.textPreview === "string"
      ? { textPreview: raw.textPreview }
      : {}),
  };
}

function parseEvalDiagnostics(raw: unknown): EvalDiagnostics | null {
  if (!isRecord(raw)) return null;
  if (!Array.isArray(raw.advertisedTools)) return null;
  const advertisedTools = raw.advertisedTools.filter(
    (t): t is string => typeof t === "string",
  );
  return {
    advertisedTools,
    reasoningEffort:
      typeof raw.reasoningEffort === "string" ? raw.reasoningEffort : null,
  };
}

function parseProviderFallback(raw: unknown): ProviderFallbackInfo | null {
  if (!isRecord(raw)) return null;
  const resolvedProvider = raw.resolvedProvider;
  const resolvedModel = raw.resolvedModel;
  if (typeof resolvedProvider !== "string" || typeof resolvedModel !== "string")
    return null;
  return {
    requestedProvider:
      typeof raw.requestedProvider === "string" ? raw.requestedProvider : null,
    requestedModel:
      typeof raw.requestedModel === "string" ? raw.requestedModel : null,
    resolvedProvider,
    resolvedModel,
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const midVal = sorted[mid];
  if (midVal === undefined) {
    throw new Error("median of empty list");
  }
  if (sorted.length % 2 === 1) return midVal;
  const prev = sorted[mid - 1];
  if (prev === undefined) {
    throw new Error("median of empty list");
  }
  return (prev + midVal) / 2;
}

function metricStats(values: readonly number[]): MetricStats {
  return {
    min: Math.min(...values),
    median: median(values),
    max: Math.max(...values),
  };
}

/** Group results by case×variant cell and compute pass-rate plus behavior-metric stats. */
export function computeCellAggregates(
  results: readonly CaseResult[],
): CellAggregate[] {
  const groups = new Map<string, CaseResult[]>();
  for (const r of results) {
    const group = groups.get(r.resultKey);
    if (group === undefined) groups.set(r.resultKey, [r]);
    else group.push(r);
  }
  const aggregates: CellAggregate[] = [];
  for (const [resultKey, group] of groups) {
    const first = group[0];
    if (first === undefined) continue;
    const passCount = group.filter((r) => r.passed).length;
    const behaviorStats: Partial<Record<NumericBehaviorMetric, MetricStats>> =
      {};
    for (const metric of NUMERIC_BEHAVIOR_METRICS) {
      const values = group
        .map((r) => r.behaviors?.[metric])
        .filter((v): v is number => typeof v === "number");
      if (values.length > 0) behaviorStats[metric] = metricStats(values);
    }
    aggregates.push({
      resultKey,
      id: first.id,
      variantId: first.variantId,
      provider: first.provider,
      model: first.model,
      repeats: group.length,
      passCount,
      passRate: passCount / group.length,
      behaviorStats,
    });
  }
  aggregates.sort((a, b) => a.resultKey.localeCompare(b.resultKey));
  return aggregates;
}

/** Validate a results JSON document (v1–v3); aggregates are recomputed from cases. */
export function parseEvalRunReport(raw: unknown): EvalRunReport {
  if (!isRecord(raw)) throw new Error("report must be an object");
  if (!Array.isArray(raw.cases))
    throw new Error("report.cases must be an array");
  const cases = raw.cases.map(parseCaseResult);
  const provider =
    typeof raw.provider === "string" ? raw.provider : "(unknown)";
  const model = typeof raw.model === "string" ? raw.model : "(unknown)";
  const variants: EvalVariant[] = Array.isArray(raw.variants)
    ? raw.variants.filter(isRecord).map((v, i) => {
        const id =
          typeof v.id === "string" && v.id.length > 0 ? v.id : `variant-${i}`;
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
          passed:
            typeof raw.totals.passed === "number"
              ? (raw.totals.passed as number)
              : 0,
          failed:
            typeof raw.totals.failed === "number"
              ? (raw.totals.failed as number)
              : 0,
          durationMs:
            typeof raw.totals.durationMs === "number"
              ? (raw.totals.durationMs as number)
              : 0,
          turnsUsed:
            typeof raw.totals.turnsUsed === "number"
              ? (raw.totals.turnsUsed as number)
              : 0,
          toolCallCount:
            typeof raw.totals.toolCallCount === "number"
              ? (raw.totals.toolCallCount as number)
              : 0,
          tokenUsage:
            parseTokenUsage(raw.totals.tokenUsage) ?? emptyTokenUsage(),
        }
      : summarizeRun(cases);
  const repeats =
    typeof raw.repeats === "number" &&
    Number.isInteger(raw.repeats) &&
    raw.repeats > 0
      ? raw.repeats
      : Math.max(1, ...cases.map((c) => c.repeat + 1));
  return {
    version: 3,
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : "",
    finishedAt: typeof raw.finishedAt === "string" ? raw.finishedAt : "",
    provider,
    model,
    repeats,
    variants,
    cases,
    aggregates: computeCellAggregates(cases),
    totals,
  };
}

function behaviorVerdicts(
  prev: CellAggregate,
  cur: CellAggregate,
): BehaviorVerdict[] {
  const verdicts: BehaviorVerdict[] = [];
  for (const metric of NUMERIC_BEHAVIOR_METRICS) {
    const prevStats = prev.behaviorStats[metric];
    const curStats = cur.behaviorStats[metric];
    if (prevStats === undefined || curStats === undefined) continue;
    const direction = BEHAVIOR_METRIC_DIRECTIONS[metric];
    let verdict: BehaviorVerdict["verdict"] = "neutral";
    if (direction === "lower" && curStats.median !== prevStats.median) {
      verdict = curStats.median < prevStats.median ? "improve" : "regress";
    }
    verdicts.push({
      metric,
      baselineMedian: prevStats.median,
      currentMedian: curStats.median,
      verdict,
    });
  }
  return verdicts;
}

/** Median of the bait metric shows the misbehavior when it exceeds the threshold. */
export function baitReproduces(
  aggregate: CellAggregate,
  bait: EvalBait,
): boolean | null {
  const stats = aggregate.behaviorStats[bait.metric];
  if (stats === undefined) return null;
  return stats.median > bait.threshold;
}

/**
 * Compare per-cell aggregates against a baseline. Pass-rate changes and
 * behavior-median changes are significant; `cases` supplies bait
 * declarations for the honesty check.
 */
export function compareToBaseline(
  current: readonly CaseResult[],
  baseline: EvalRunReport,
  cases: readonly EvalCase[] = [],
  options: { allowProviderFallback?: boolean } = {},
): BaselineCompare {
  const currentAggregates = computeCellAggregates(current);
  const prevByKey = new Map(baseline.aggregates.map((a) => [a.resultKey, a]));
  // v1-style id-only fallback when the baseline had a single default variant.
  const prevById = new Map(baseline.aggregates.map((a) => [a.id, a]));
  const baitById = new Map<string, EvalBait>();
  for (const c of cases) {
    if (c.bait !== undefined) baitById.set(c.id, c.bait);
  }
  const deltas: BaselineDelta[] = [];
  let improved = 0;
  let regressed = 0;
  let unchanged = 0;
  let added = 0;
  let behaviorImproved = 0;
  let behaviorRegressed = 0;
  let baitFlags = 0;

  for (const cur of currentAggregates) {
    const prev =
      prevByKey.get(cur.resultKey) ??
      (baseline.aggregates.length > 0 && baseline.variants.length <= 1
        ? prevById.get(cur.id)
        : undefined);
    if (prev === undefined) {
      deltas.push({
        resultKey: cur.resultKey,
        id: cur.id,
        variantId: cur.variantId,
        previousPassRate: null,
        currentPassRate: cur.passRate,
        status: "new",
        behaviorVerdicts: [],
      });
      added++;
      continue;
    }
    if (
      options.allowProviderFallback !== true &&
      (prev.provider !== cur.provider || prev.model !== cur.model)
    ) {
      throw new Error(
        `cannot compare baseline for ${cur.resultKey}: baseline ran on ` +
          `${prev.provider}/${prev.model} but current run resolved to ` +
          `${cur.provider}/${cur.model} — pass --allow-provider-fallback to compare anyway`,
      );
    }
    let status: BaselineDelta["status"];
    if (prev.passRate === cur.passRate) {
      status = "unchanged";
      unchanged++;
    } else if (cur.passRate > prev.passRate) {
      status = "improved";
      improved++;
    } else {
      status = "regressed";
      regressed++;
    }
    const verdicts = behaviorVerdicts(prev, cur);
    behaviorImproved += verdicts.filter((v) => v.verdict === "improve").length;
    behaviorRegressed += verdicts.filter((v) => v.verdict === "regress").length;
    const bait = baitById.get(cur.id);
    let baitNotReproducing: string | undefined;
    if (bait !== undefined && baitReproduces(prev, bait) === false) {
      baitNotReproducing =
        `bait metric ${bait.metric} median did not exceed ${bait.threshold} on baseline — ` +
        "the case no longer reproduces its misbehavior";
      baitFlags++;
    }
    deltas.push({
      resultKey: cur.resultKey,
      id: cur.id,
      variantId: cur.variantId,
      previousPassRate: prev.passRate,
      currentPassRate: cur.passRate,
      status,
      behaviorVerdicts: verdicts,
      ...(baitNotReproducing !== undefined ? { baitNotReproducing } : {}),
    });
  }

  return {
    deltas,
    improved,
    regressed,
    unchanged,
    added,
    behaviorImproved,
    behaviorRegressed,
    baitFlags,
  };
}
