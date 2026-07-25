#!/usr/bin/env bun
/**
 * Local capability eval runner.
 *
 * Uses the product non-TUI path (`loadConfig` + `runExec`) against fixture
 * copies, then objective verify.sh graders. Supports multi-model matrices so
 * one run can try different provider/model combos. See evals/capability/README.md.
 */

import { cp, mkdir, chmod, writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { loadConfig } from "../src/config/index.js";
import { runExec } from "../src/exec/runner.js";
import {
  loadEvalCases,
  filterCases,
  resolveFixturePath,
  compareToBaseline,
  parseEvalRunReport,
  summarizeRun,
  parseMatrix,
  expandMatrix,
  makeResultKey,
  type CaseResult,
  type EvalCase,
  type EvalRunReport,
  type EvalVariant,
  type EvalTokenUsage,
} from "../evals/capability/lib.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CASES_ROOT = join(REPO_ROOT, "evals", "capability", "cases");

type CliOptions = {
  caseSelector: string;
  provider?: string;
  model?: string;
  /** Comma-separated matrix of provider:model cells. */
  matrix?: string;
  configPath?: string;
  outPath?: string;
  baselinePath?: string;
  skipPermissions: boolean;
  maxTurnsOverride?: number;
  dryRun: boolean;
};

function printUsage(): void {
  console.log(`Usage: bun scripts/eval-capability.ts [options]

  --case <id|all>       Case id (default: all)
  --provider <name>     Provider override (single-variant run)
  --model <id>          Model override (single-variant run)
  --matrix <cells>      Multi-variant: "p1:m1,p2:m2" or "label=p:m,..."
  --config <path>       Settings file override
  --out <path>          Write results JSON
  --baseline <path>     Compare to prior results JSON
  --ask-permissions     Do not pass --dangerously-skip-permissions
  --max-turns <n>       Override case maxTurns
  --dry-run             List cases × variants only
  -h, --help            Show help
`);
}

function parseArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = {
    caseSelector: "all",
    skipPermissions: true,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} requires a value`);
      return v;
    };
    switch (a) {
      case "-h":
      case "--help":
        printUsage();
        process.exit(0);
        break;
      case "--case":
        opts.caseSelector = next();
        break;
      case "--provider":
        opts.provider = next();
        break;
      case "--model":
        opts.model = next();
        break;
      case "--matrix":
        opts.matrix = next();
        break;
      case "--config":
        opts.configPath = next();
        break;
      case "--out":
        opts.outPath = next();
        break;
      case "--baseline":
        opts.baselinePath = next();
        break;
      case "--ask-permissions":
        opts.skipPermissions = false;
        break;
      case "--max-turns": {
        const n = Number(next());
        if (!Number.isFinite(n) || n <= 0) throw new Error("--max-turns must be a positive number");
        opts.maxTurnsOverride = Math.floor(n);
        break;
      }
      case "--dry-run":
        opts.dryRun = true;
        break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  return opts;
}

function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, [...args], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", (e) => {
      resolvePromise({
        exitCode: 1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: `${Buffer.concat(err).toString("utf8")}${e.message}`,
      });
    });
    child.on("close", (code) => {
      resolvePromise({
        exitCode: code ?? 1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
  });
}

async function prepareWorkdir(caseDef: EvalCase): Promise<string> {
  const fixtureAbs = resolveFixturePath(REPO_ROOT, caseDef.fixture);
  const work = await mkdtemp(join(tmpdir(), `corbits-eval-${caseDef.id}-`));
  await cp(fixtureAbs, work, { recursive: true });
  return work;
}

async function runVerify(
  caseDef: EvalCase,
  workdir: string,
): Promise<{ exitCode: number; output: string; durationMs: number }> {
  const verifyPath = join(caseDef.caseDir, caseDef.verify);
  await chmod(verifyPath, 0o755).catch(() => undefined);
  const started = Date.now();
  const result = await runCommand("bash", [verifyPath], workdir);
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  return { exitCode: result.exitCode, output, durationMs: Date.now() - started };
}

async function resolveVariantLabels(
  variant: EvalVariant,
  opts: CliOptions,
): Promise<{ provider: string; model: string }> {
  try {
    const probe: string[] = ["exec", "--cwd", REPO_ROOT];
    if (variant.provider !== undefined) probe.push("--provider", variant.provider);
    if (variant.model !== undefined) probe.push("--model", variant.model);
    if (opts.configPath !== undefined) probe.push("--config", opts.configPath);
    probe.push("--force", "probe");
    const cfg = await loadConfig(probe, { allowUnconfigured: true });
    if (cfg.configured) {
      return { provider: cfg.providerName, model: cfg.model };
    }
  } catch {
    // fall through
  }
  return {
    provider: variant.provider ?? opts.provider ?? "(default)",
    model: variant.model ?? opts.model ?? "(default)",
  };
}

function failResult(
  caseDef: EvalCase,
  variant: EvalVariant,
  labels: { provider: string; model: string },
  opts: CliOptions,
  started: number,
  error: string,
  partial?: Partial<CaseResult>,
): CaseResult {
  const maxTurns = opts.maxTurnsOverride ?? caseDef.maxTurns ?? null;
  return {
    resultKey: makeResultKey(variant.id, caseDef.id),
    id: caseDef.id,
    tier: caseDef.tier,
    title: caseDef.title,
    variantId: variant.id,
    provider: labels.provider,
    model: labels.model,
    passed: false,
    agentExitCode: null,
    verifyExitCode: null,
    durationMs: Date.now() - started,
    agentDurationMs: null,
    verifyDurationMs: null,
    status: null,
    sessionId: null,
    turnsUsed: null,
    toolCallCount: null,
    tokenUsage: null,
    maxTurns,
    overBudget: null,
    skipPermissions: opts.skipPermissions,
    error,
    ...partial,
  };
}

async function runCase(
  caseDef: EvalCase,
  variant: EvalVariant,
  opts: CliOptions,
): Promise<CaseResult> {
  const started = Date.now();
  const labels = await resolveVariantLabels(variant, opts);
  let workdir: string | null = null;
  try {
    workdir = await prepareWorkdir(caseDef);
    console.log(`\n=== ${variant.id} × ${caseDef.id} (${caseDef.tier}) — ${caseDef.title}`);
    console.log(`provider/model: ${labels.provider} / ${labels.model}`);
    console.log(`workdir: ${workdir}`);

    const argv: string[] = ["exec", "--cwd", workdir];
    if (variant.provider !== undefined) argv.push("--provider", variant.provider);
    if (variant.model !== undefined) argv.push("--model", variant.model);
    if (opts.configPath !== undefined) argv.push("--config", opts.configPath);
    if (opts.skipPermissions) argv.push("--dangerously-skip-permissions");
    argv.push("--force");

    const maxTurns = opts.maxTurnsOverride ?? caseDef.maxTurns ?? null;
    if (maxTurns !== null) {
      process.env.CORBITS_EVAL_MAX_TURNS = String(maxTurns);
    }

    argv.push(caseDef.prompt);

    const config = await loadConfig(argv, { allowUnconfigured: false });
    if (!config.configured) {
      throw new Error("Provider not configured for eval run");
    }

    const agentStarted = Date.now();
    const execResult = await runExec(config);
    const agentDurationMs = execResult.durationMs ?? Date.now() - agentStarted;
    const agentExitCode = execResult.exitCode;
    const turnsUsed = execResult.turnsUsed ?? null;
    const toolCallCount = execResult.toolCallCount ?? null;
    const tokenUsage: EvalTokenUsage | null = execResult.tokenUsage ?? null;
    const status = execResult.status ?? null;
    const sessionId = execResult.sessionId ?? null;

    console.log(`agent exit: ${agentExitCode}  status: ${status ?? "?"}`);
    console.log(
      `agent metrics: turns=${turnsUsed ?? "?"} tools=${toolCallCount ?? "?"} ` +
        `tokens.in=${tokenUsage?.input ?? "?"} tokens.out=${tokenUsage?.output ?? "?"} ` +
        `duration=${agentDurationMs}ms`,
    );
    if (execResult.error !== undefined) {
      console.log(`agent error: ${execResult.error}`);
    }

    const verify = await runVerify(caseDef, workdir);
    if (verify.output.trim().length > 0) {
      console.log(verify.output.trimEnd());
    }
    console.log(`verify exit: ${verify.exitCode}  (${verify.durationMs}ms)`);

    const passed = agentExitCode === 0 && verify.exitCode === 0;
    const overBudget =
      maxTurns !== null && turnsUsed !== null ? turnsUsed > maxTurns : null;
    const preview =
      execResult.text.length > 400 ? `${execResult.text.slice(0, 400)}…` : execResult.text;

    return {
      resultKey: makeResultKey(variant.id, caseDef.id),
      id: caseDef.id,
      tier: caseDef.tier,
      title: caseDef.title,
      variantId: variant.id,
      provider: execResult.provider ?? config.providerName ?? labels.provider,
      model: execResult.model ?? config.model ?? labels.model,
      passed,
      agentExitCode,
      verifyExitCode: verify.exitCode,
      durationMs: Date.now() - started,
      agentDurationMs,
      verifyDurationMs: verify.durationMs,
      status,
      sessionId,
      turnsUsed,
      toolCallCount,
      tokenUsage,
      maxTurns,
      overBudget,
      skipPermissions: opts.skipPermissions,
      error: passed
        ? null
        : execResult.error
          ?? (verify.exitCode !== 0 ? `verify failed (exit ${verify.exitCode})` : `agent exit ${agentExitCode}`),
      textPreview: preview,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`case ${caseDef.id} (${variant.id}) failed: ${message}`);
    return failResult(caseDef, variant, labels, opts, started, message);
  } finally {
    if (workdir !== null) {
      await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function formatMetricsLine(r: CaseResult): string {
  const parts = [`${r.durationMs}ms`];
  if (r.turnsUsed !== null) parts.push(`turns=${r.turnsUsed}`);
  if (r.toolCallCount !== null) parts.push(`tools=${r.toolCallCount}`);
  if (r.tokenUsage !== null) {
    parts.push(`tok=${r.tokenUsage.input}+${r.tokenUsage.output}`);
  }
  if (r.overBudget === true) parts.push("OVER_BUDGET");
  return parts.join(" ");
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const all = await loadEvalCases(CASES_ROOT);
  const selected = filterCases(all, opts.caseSelector);
  const variants = parseMatrix(opts.matrix, {
    provider: opts.provider,
    model: opts.model,
  });
  const plan = expandMatrix(selected, variants);

  console.log(
    `Capability eval — ${selected.length} case(s) × ${variants.length} variant(s) = ${plan.length} run(s)`,
  );
  console.log("Cases:");
  for (const c of selected) {
    console.log(`  - ${c.id} [${c.tier}] fixture=${c.fixture}`);
  }
  console.log("Variants:");
  for (const v of variants) {
    console.log(
      `  - ${v.id}  provider=${v.provider ?? "(default)"} model=${v.model ?? "(default)"}`,
    );
  }

  if (opts.dryRun) {
    console.log("dry-run: no inference");
    for (const { caseDef, variant } of plan) {
      console.log(`  would run: ${variant.id} × ${caseDef.id}`);
    }
    return 0;
  }

  const startedAt = new Date().toISOString();
  const results: CaseResult[] = [];

  for (const { caseDef, variant } of plan) {
    const result = await runCase(caseDef, variant, opts);
    results.push(result);
  }

  const finishedAt = new Date().toISOString();
  const totals = summarizeRun(results);
  const primary = variants[0]!;
  const labels = await resolveVariantLabels(primary, opts);

  const report: EvalRunReport = {
    version: 2,
    startedAt,
    finishedAt,
    provider: labels.provider,
    model: labels.model,
    variants,
    cases: results,
    totals,
  };

  console.log(
    `\n=== Summary: ${totals.passed}/${totals.total} passed  ` +
      `duration=${totals.durationMs}ms turns=${totals.turnsUsed} tools=${totals.toolCallCount} ` +
      `tokens.in=${totals.tokenUsage.input} tokens.out=${totals.tokenUsage.output}`,
  );
  for (const r of results) {
    const mark = r.passed ? "PASS" : "FAIL";
    console.log(
      `  ${mark}  ${r.variantId} × ${r.id}  ${formatMetricsLine(r)}` +
        `${r.error ? `  (${r.error})` : ""}`,
    );
  }

  if (opts.outPath !== undefined) {
    const abs = resolve(opts.outPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`wrote ${abs}`);
  }

  let exitCode = totals.failed > 0 ? 1 : 0;

  if (opts.baselinePath !== undefined) {
    const raw: unknown = JSON.parse(await readFile(resolve(opts.baselinePath), "utf8"));
    const baseline = parseEvalRunReport(raw);
    const cmp = compareToBaseline(results, baseline);
    console.log("\n=== Baseline compare");
    for (const d of cmp.deltas) {
      const metricBits: string[] = [];
      if (d.metrics?.durationMsDelta !== null && d.metrics?.durationMsDelta !== undefined) {
        metricBits.push(`Δms=${d.metrics.durationMsDelta}`);
      }
      if (d.metrics?.turnsUsedDelta !== null && d.metrics?.turnsUsedDelta !== undefined) {
        metricBits.push(`Δturns=${d.metrics.turnsUsedDelta}`);
      }
      if (d.metrics?.tokenOutputDelta !== null && d.metrics?.tokenOutputDelta !== undefined) {
        metricBits.push(`Δtok.out=${d.metrics.tokenOutputDelta}`);
      }
      console.log(
        `  ${d.status.padEnd(10)} ${d.resultKey}  prev=${d.previous === null ? "n/a" : d.previous}  now=${d.current}` +
          (metricBits.length > 0 ? `  ${metricBits.join(" ")}` : ""),
      );
    }
    console.log(
      `improved=${cmp.improved} regressed=${cmp.regressed} unchanged=${cmp.unchanged} new=${cmp.added}`,
    );
    if (cmp.regressed > 0) exitCode = 1;
  }

  return exitCode;
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(2);
    });
}
