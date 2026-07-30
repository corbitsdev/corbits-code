#!/usr/bin/env bun
/**
 * Local capability eval runner.
 *
 * Uses the product non-TUI path (`loadConfig` + `runExec`) against fixture
 * copies, then objective verify.sh graders. Supports multi-model matrices so
 * one run can try different provider/model combos. See evals/capability/README.md.
 */

import { cp, mkdir, chmod, writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { loadConfig } from "../src/config/index.js";
import { runExec } from "../src/exec/runner.js";
import { SETTINGS_DIR_NAME } from "../src/branding.js";
import {
  loadEvalCases,
  filterCases,
  resolveFixturePath,
  compareToBaseline,
  computeCellAggregates,
  parseEvalRunReport,
  summarizeRun,
  parseMatrix,
  expandMatrix,
  makeResultKey,
  evaluateSoftBudget,
  httpFixtureEnv,
  withEnv,
  detectProviderFallback,
  formatProviderFallback,
  resolveRequestedProviderModel,
  type CaseResult,
  type EvalCase,
  type EvalRunReport,
  type EvalVariant,
  type EvalTokenUsage,
  type ProviderFallbackInfo,
} from "../evals/capability/lib.js";
import {
  deriveBehaviorMetrics,
  parseCapturedRunSummary,
  type BehaviorMetrics,
} from "../evals/capability/behaviors.js";

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
  /** Wall-clock limit for runExec (ms). */
  agentTimeoutMs: number;
  /** Wall-clock limit for verify.sh (ms). */
  verifyTimeoutMs: number;
  /** Runs per case×variant cell (gate runs use 5; freeze runs use 3). */
  repeats: number;
  dryRun: boolean;
  /**
   * Allow a run/comparison to proceed when the resolved provider/model
   * differs from what was requested, instead of hard-failing.
   */
  allowProviderFallback: boolean;
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
  --max-turns <n>       Soft turn budget (case fails if turnsUsed exceeds; not a hard kill)
  --agent-timeout-ms <n> Wall-clock limit for runExec (default 600000)
  --verify-timeout-ms <n> Wall-clock limit for verify.sh (default 120000)
  --repeats <n>         Runs per case×variant cell (default 1; gate runs use 5)
  --dry-run             List cases × variants only
  --allow-provider-fallback  Allow resolved provider/model to differ from
                             what was requested (default: hard-fail)
  -h, --help            Show help
`);
}

function parseArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = {
    caseSelector: "all",
    skipPermissions: true,
    repeats: 1,
    dryRun: false,
    allowProviderFallback: false,
    agentTimeoutMs: Number(process.env.CORBITS_EVAL_AGENT_TIMEOUT_MS ?? 600_000),
    verifyTimeoutMs: Number(process.env.CORBITS_EVAL_VERIFY_TIMEOUT_MS ?? 120_000),
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
      case "--agent-timeout-ms": {
        const n = Number(next());
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error("--agent-timeout-ms must be a positive number");
        }
        opts.agentTimeoutMs = Math.floor(n);
        break;
      }
      case "--verify-timeout-ms": {
        const n = Number(next());
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error("--verify-timeout-ms must be a positive number");
        }
        opts.verifyTimeoutMs = Math.floor(n);
        break;
      }
      case "--repeats": {
        const n = Number(next());
        if (!Number.isInteger(n) || n <= 0) throw new Error("--repeats must be a positive integer");
        opts.repeats = n;
        break;
      }
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--allow-provider-fallback":
        opts.allowProviderFallback = true;
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
  timeoutMs: number,
  extraEnv: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, [...args], {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // Escalate if the process ignores SIGTERM.
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }, 5_000).unref();
    }, timeoutMs);
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: 1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: `${Buffer.concat(err).toString("utf8")}${e.message}`,
        timedOut,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: timedOut ? 124 : (code ?? 1),
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8")
          + (timedOut ? `\n[eval] timed out after ${timeoutMs}ms` : ""),
        timedOut,
      });
    });
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function prepareWorkdir(caseDef: EvalCase): Promise<{ workdir: string; capturePath: string }> {
  const fixtureAbs = resolveFixturePath(REPO_ROOT, caseDef.fixture);
  const work = await mkdtemp(join(tmpdir(), `corbits-eval-${caseDef.id}-`));
  await cp(fixtureAbs, work, { recursive: true });
  // Sibling of the workdir so the agent and verify.sh never see the capture.
  const capturePath = `${work}-run-summary.json`;
  await installRunCaptureHook(work, capturePath);
  return { workdir: work, capturePath };
}

/**
 * Drop a post-run lifecycle hook into the workdir so the product path hands us
 * the full turn stream (tool calls + assistant content) for behavior metrics.
 * The hook writes the postRun payload verbatim and swallows other kinds.
 */
async function installRunCaptureHook(workdir: string, capturePath: string): Promise<void> {
  const hooksDir = join(workdir, SETTINGS_DIR_NAME, "hooks");
  await mkdir(hooksDir, { recursive: true });
  const script = [
    "#!/bin/sh",
    'if [ "$1" = "postRun" ]; then',
    `  cat > ${JSON.stringify(capturePath)}`,
    "else",
    "  cat > /dev/null",
    "fi",
    "",
  ].join("\n");
  const hookPath = join(hooksDir, "eval-run-capture.sh");
  await writeFile(hookPath, script, "utf8");
  await chmod(hookPath, 0o755);
}

async function readCapturedBehaviors(capturePath: string): Promise<BehaviorMetrics | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(capturePath, "utf8"));
    return deriveBehaviorMetrics(parseCapturedRunSummary(raw));
  } catch {
    return null;
  }
}

type HTTPFixture = {
  url: string;
  token: string;
  close: () => Promise<void>;
};

/**
 * Hermetic local page for web-fetch cases: 127.0.0.1 on an ephemeral port,
 * serving a small HTML page with a per-run token. Started and stopped per
 * case run; never left running.
 */
function startHTTPFixture(): Promise<HTTPFixture> {
  const token = randomBytes(8).toString("hex");
  const html =
    "<html><head><title>Release info</title></head>"
    + `<body><h1>Release info</h1><p>build code: <code>${token}</code></p></body></html>`;
  return new Promise((resolvePromise, reject) => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html);
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("HTTP fixture failed to bind"));
        return;
      }
      resolvePromise({
        url: `http://127.0.0.1:${address.port}/`,
        token,
        close: () =>
          new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
            server.closeAllConnections();
          }),
      });
    });
  });
}

async function runVerify(
  caseDef: EvalCase,
  workdir: string,
  timeoutMs: number,
  extraEnv: Record<string, string> = {},
): Promise<{ exitCode: number; output: string; durationMs: number; timedOut: boolean }> {
  const verifyPath = join(caseDef.caseDir, caseDef.verify);
  await chmod(verifyPath, 0o755).catch(() => undefined);
  const started = Date.now();
  const result = await runCommand("bash", [verifyPath], workdir, timeoutMs, extraEnv);
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  return {
    exitCode: result.exitCode,
    output,
    durationMs: Date.now() - started,
    timedOut: result.timedOut,
  };
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
  repeat: number,
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
    repeat,
    behaviors: null,
    providerFallback: null,
    ...partial,
  };
}

async function runCase(
  caseDef: EvalCase,
  variant: EvalVariant,
  opts: CliOptions,
  repeat: number,
): Promise<CaseResult> {
  const started = Date.now();
  const labels = await resolveVariantLabels(variant, opts);
  let workdir: string | null = null;
  let capturePath: string | null = null;
  let httpFixture: HTTPFixture | null = null;
  let providerFallback: ProviderFallbackInfo | null = null;
  try {
    const prepared = await prepareWorkdir(caseDef);
    workdir = prepared.workdir;
    capturePath = prepared.capturePath;
    console.log(
      `\n=== ${variant.id} × ${caseDef.id} (${caseDef.tier})`
        + ` [repeat ${repeat + 1}/${opts.repeats}] — ${caseDef.title}`,
    );
    console.log(`provider/model: ${labels.provider} / ${labels.model}`);
    console.log(`workdir: ${workdir}`);

    let prompt = caseDef.prompt;
    if (caseDef.httpFixture === true) {
      httpFixture = await startHTTPFixture();
      prompt = prompt.replaceAll("{{HTTP_URL}}", httpFixture.url);
      console.log(`http fixture: ${httpFixture.url}`);
    }

    // Force the run's resolved provider/model (from the catalog/OAuth-aware
    // loadConfig probe above) explicitly into this case's argv rather than
    // leaving it to ambient default resolution inside the fixture workdir.
    // The workdir is a throwaway copy with no project-local .corbits/settings.json
    // of its own, so ambient resolution there can silently land on a different
    // provider than the one the run actually resolved at plan time (e.g. this
    // repo's local settings pin an OAuth-profile provider that the isolated
    // fixture copy has no way to see) — exactly the substitution this eval
    // exists to catch, not commit.
    const requested = resolveRequestedProviderModel(variant, labels);
    const argv: string[] = ["exec", "--cwd", workdir];
    if (requested.provider !== undefined) argv.push("--provider", requested.provider);
    if (requested.model !== undefined) argv.push("--model", requested.model);
    if (opts.configPath !== undefined) argv.push("--config", opts.configPath);
    if (opts.skipPermissions) argv.push("--dangerously-skip-permissions");
    argv.push("--force");

    const maxTurns = opts.maxTurnsOverride ?? caseDef.maxTurns ?? null;
    // maxTurns is a soft post-run budget (case fails if exceeded). It does not
    // hard-kill the agent mid-run — product path has no mid-turn budget hook yet.

    argv.push(prompt);

    const config = await loadConfig(argv, { allowUnconfigured: false });
    if (!config.configured) {
      throw new Error("Provider not configured for eval run");
    }

    const agentStarted = Date.now();
    // runExec runs the agent in-process (no child, unlike verify.sh below), so
    // the fixture origin must reach it via process.env directly for the
    // eval-only SSRF exception in src/tools/ssrf-guard.ts to activate.
    const execResult = await withTimeout(
      httpFixture !== null
        ? withEnv(httpFixtureEnv(httpFixture), () => runExec(config))
        : runExec(config),
      opts.agentTimeoutMs,
      `agent (${caseDef.id})`,
    );
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

    const resolvedProvider = execResult.provider ?? config.providerName ?? labels.provider;
    const resolvedModel = execResult.model ?? config.model ?? labels.model;
    providerFallback = detectProviderFallback({
      requestedProvider: requested.provider,
      requestedModel: requested.model,
      resolvedProvider,
      resolvedModel,
    });
    if (providerFallback !== null) {
      const message = formatProviderFallback(providerFallback);
      if (!opts.allowProviderFallback) {
        throw new Error(`${message} (pass --allow-provider-fallback to allow this)`);
      }
      console.warn(`[eval] ${message}`);
    }

    const behaviors = await readCapturedBehaviors(capturePath);
    if (behaviors === null) {
      console.log("behaviors: capture missing (no turn stream recorded)");
    } else {
      console.log(
        `behaviors: shell=${behaviors.shellCommandCount} env=${behaviors.envAssignmentCommandCount}`
          + ` net=${behaviors.networkCommandCount} web_fetch=${behaviors.webFetchToolCallCount}`
          + ` shellEdit=${behaviors.editViaShellCount} repeats=${behaviors.repeatedSearchCount}`
          + ` toolOnlyStreak=${behaviors.longestToolOnlyStreak}`
          + ` maxTurnMs=${behaviors.maxTurnDurationMs}`,
      );
    }

    const verifyEnv: Record<string, string> = httpFixture !== null ? httpFixtureEnv(httpFixture) : {};
    const verify = await runVerify(caseDef, workdir, opts.verifyTimeoutMs, verifyEnv);
    if (verify.output.trim().length > 0) {
      console.log(verify.output.trimEnd());
    }
    console.log(`verify exit: ${verify.exitCode}  (${verify.durationMs}ms)`);

    // Soft maxTurns: fail when exceeded; fail closed when turns weren't reported.
    const budget = evaluateSoftBudget({ maxTurns, turnsUsed });
    const overBudget = budget.overBudget;
    const passed =
      agentExitCode === 0 && verify.exitCode === 0 && overBudget !== true;
    const preview =
      execResult.text.length > 400 ? `${execResult.text.slice(0, 400)}…` : execResult.text;

    let error: string | null = null;
    if (!passed) {
      if (budget.budgetError !== null) {
        error = budget.budgetError;
      } else if (verify.timedOut) {
        error = `verify timed out after ${opts.verifyTimeoutMs}ms`;
      } else if (execResult.error !== undefined) {
        error = execResult.error;
      } else if (verify.exitCode !== 0) {
        error = `verify failed (exit ${verify.exitCode})`;
      } else {
        error = `agent exit ${agentExitCode}`;
      }
    }

    return {
      resultKey: makeResultKey(variant.id, caseDef.id),
      id: caseDef.id,
      tier: caseDef.tier,
      title: caseDef.title,
      variantId: variant.id,
      provider: resolvedProvider,
      model: resolvedModel,
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
      error,
      repeat,
      behaviors,
      providerFallback,
      textPreview: preview,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`case ${caseDef.id} (${variant.id}) failed: ${message}`);
    return failResult(caseDef, variant, labels, opts, started, repeat, message, {
      providerFallback,
    });
  } finally {
    if (httpFixture !== null) {
      await httpFixture.close().catch(() => undefined);
    }
    if (workdir !== null) {
      await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
    }
    if (capturePath !== null) {
      await rm(capturePath, { force: true }).catch(() => undefined);
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

  console.log(`Repeats per cell: ${opts.repeats}`);

  if (opts.dryRun) {
    console.log("dry-run: no inference");
    for (const { caseDef, variant } of plan) {
      console.log(`  would run: ${variant.id} × ${caseDef.id} × ${opts.repeats} repeat(s)`);
    }
    return 0;
  }

  const startedAt = new Date().toISOString();
  const results: CaseResult[] = [];

  for (const { caseDef, variant } of plan) {
    for (let repeat = 0; repeat < opts.repeats; repeat++) {
      const result = await runCase(caseDef, variant, opts, repeat);
      results.push(result);
    }
  }

  const finishedAt = new Date().toISOString();
  const totals = summarizeRun(results);
  const primary = variants[0]!;
  const labels = await resolveVariantLabels(primary, opts);

  const aggregates = computeCellAggregates(results);
  const report: EvalRunReport = {
    version: 3,
    startedAt,
    finishedAt,
    provider: labels.provider,
    model: labels.model,
    repeats: opts.repeats,
    variants,
    cases: results,
    aggregates,
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
      `  ${mark}  ${r.variantId} × ${r.id} #${r.repeat + 1}  ${formatMetricsLine(r)}` +
        `${r.error ? `  (${r.error})` : ""}`,
    );
  }

  if (opts.repeats > 1) {
    console.log("\n=== Aggregates (per cell)");
    for (const cell of aggregates) {
      const statBits = Object.entries(cell.behaviorStats)
        .filter(([, s]) => s.max > 0)
        .map(([metric, s]) => `${metric}=${s.min}/${s.median}/${s.max}`);
      console.log(
        `  ${cell.resultKey}  pass ${cell.passCount}/${cell.repeats}` +
          (statBits.length > 0 ? `  ${statBits.join(" ")}` : ""),
      );
    }
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
    const cmp = compareToBaseline(results, baseline, selected, {
      allowProviderFallback: opts.allowProviderFallback,
    });
    console.log("\n=== Baseline compare (aggregates)");
    for (const d of cmp.deltas) {
      const rate = (r: number | null): string => (r === null ? "n/a" : r.toFixed(2));
      console.log(
        `  ${d.status.padEnd(10)} ${d.resultKey}  passRate ${rate(d.previousPassRate)} -> ${rate(d.currentPassRate)}`,
      );
      for (const v of d.behaviorVerdicts) {
        if (v.verdict === "neutral" && v.baselineMedian === v.currentMedian) continue;
        console.log(
          `      ${v.verdict.padEnd(8)} ${v.metric}  median ${v.baselineMedian} -> ${v.currentMedian}`,
        );
      }
      if (d.baitNotReproducing !== undefined) {
        console.log(`      BAIT FLAG  ${d.baitNotReproducing}`);
      }
    }
    console.log(
      `pass: improved=${cmp.improved} regressed=${cmp.regressed} unchanged=${cmp.unchanged} new=${cmp.added}  ` +
        `behavior: improved=${cmp.behaviorImproved} regressed=${cmp.behaviorRegressed}  ` +
        `baitFlags=${cmp.baitFlags}`,
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
