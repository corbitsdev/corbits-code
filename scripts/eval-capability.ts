#!/usr/bin/env bun
/**
 * Local capability eval runner.
 *
 * Uses the product non-TUI path (`loadConfig` + `runExec`) against fixture
 * copies, then objective verify.sh graders. See evals/capability/README.md.
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
  type CaseResult,
  type EvalCase,
  type EvalRunReport,
} from "../evals/capability/lib.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CASES_ROOT = join(REPO_ROOT, "evals", "capability", "cases");

type CliOptions = {
  caseSelector: string;
  provider?: string;
  model?: string;
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
  --provider <name>     Provider override
  --model <id>          Model override
  --config <path>       Settings file override
  --out <path>          Write results JSON
  --baseline <path>     Compare to prior results JSON
  --ask-permissions     Do not pass --dangerously-skip-permissions
  --max-turns <n>       Override case maxTurns
  --dry-run             List cases only
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
  // Ensure grader is executable after we copy it next to the workdir... we run
  // verify from the case dir with WORKDIR env, so no need to copy verify into work.
  return work;
}

async function runVerify(caseDef: EvalCase, workdir: string): Promise<{ exitCode: number; output: string }> {
  const verifyPath = join(caseDef.caseDir, caseDef.verify);
  await chmod(verifyPath, 0o755).catch(() => undefined);
  const result = await runCommand("bash", [verifyPath], workdir);
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  return { exitCode: result.exitCode, output };
}

async function runCase(caseDef: EvalCase, opts: CliOptions): Promise<CaseResult> {
  const started = Date.now();
  let workdir: string | null = null;
  try {
    workdir = await prepareWorkdir(caseDef);
    console.log(`\n=== ${caseDef.id} (${caseDef.tier}) — ${caseDef.title}`);
    console.log(`workdir: ${workdir}`);

    const argv: string[] = ["exec", "--cwd", workdir];
    if (opts.provider !== undefined) argv.push("--provider", opts.provider);
    if (opts.model !== undefined) argv.push("--model", opts.model);
    if (opts.configPath !== undefined) argv.push("--config", opts.configPath);
    if (opts.skipPermissions) argv.push("--dangerously-skip-permissions");
    argv.push("--force");
    // Optional turn budget via env for directors that honor it later; prompt is the task.
    if (opts.maxTurnsOverride !== undefined || caseDef.maxTurns !== undefined) {
      const budget = opts.maxTurnsOverride ?? caseDef.maxTurns!;
      process.env.CORBITS_EVAL_MAX_TURNS = String(budget);
    }
    argv.push(caseDef.prompt);

    const config = await loadConfig(argv, { allowUnconfigured: false });
    if (!config.configured) {
      throw new Error("Provider not configured for eval run");
    }

    const execResult = await runExec(config);
    const agentExitCode = execResult.exitCode;
    console.log(`agent exit: ${agentExitCode}`);
    if (execResult.error !== undefined) {
      console.log(`agent error: ${execResult.error}`);
    }

    const verify = await runVerify(caseDef, workdir);
    if (verify.output.trim().length > 0) {
      console.log(verify.output.trimEnd());
    }
    console.log(`verify exit: ${verify.exitCode}`);

    const passed = agentExitCode === 0 && verify.exitCode === 0;
    const preview =
      execResult.text.length > 400 ? `${execResult.text.slice(0, 400)}…` : execResult.text;

    return {
      id: caseDef.id,
      tier: caseDef.tier,
      title: caseDef.title,
      passed,
      agentExitCode,
      verifyExitCode: verify.exitCode,
      durationMs: Date.now() - started,
      error: passed
        ? null
        : execResult.error
          ?? (verify.exitCode !== 0 ? `verify failed (exit ${verify.exitCode})` : `agent exit ${agentExitCode}`),
      textPreview: preview,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`case ${caseDef.id} failed: ${message}`);
    return {
      id: caseDef.id,
      tier: caseDef.tier,
      title: caseDef.title,
      passed: false,
      agentExitCode: null,
      verifyExitCode: null,
      durationMs: Date.now() - started,
      error: message,
    };
  } finally {
    if (workdir !== null) {
      await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const all = await loadEvalCases(CASES_ROOT);
  const selected = filterCases(all, opts.caseSelector);

  console.log(`Capability eval — ${selected.length} case(s) from ${CASES_ROOT}`);
  for (const c of selected) {
    console.log(`  - ${c.id} [${c.tier}] fixture=${c.fixture}`);
  }

  if (opts.dryRun) {
    console.log("dry-run: no inference");
    return 0;
  }

  const startedAt = new Date().toISOString();
  const results: CaseResult[] = [];

  for (const c of selected) {
    const result = await runCase(c, opts);
    results.push(result);
  }

  let provider = opts.provider ?? "(default)";
  let model = opts.model ?? "(default)";
  try {
    const probe: string[] = ["exec", "--cwd", REPO_ROOT];
    if (opts.provider !== undefined) probe.push("--provider", opts.provider);
    if (opts.model !== undefined) probe.push("--model", opts.model);
    if (opts.configPath !== undefined) probe.push("--config", opts.configPath);
    probe.push("--force", "probe");
    const cfg = await loadConfig(probe, { allowUnconfigured: true });
    if (cfg.configured) {
      provider = cfg.providerName;
      model = cfg.model;
    }
  } catch {
    // keep placeholders
  }

  const finishedAt = new Date().toISOString();
  const report: EvalRunReport = {
    version: 1,
    startedAt,
    finishedAt,
    provider,
    model,
    cases: results,
  };

  const summary = summarizeRun(results);
  console.log(`\n=== Summary: ${summary.passed}/${summary.total} passed (${provider} / ${model})`);
  for (const r of results) {
    const mark = r.passed ? "PASS" : "FAIL";
    console.log(`  ${mark}  ${r.id}  ${r.durationMs}ms${r.error ? `  (${r.error})` : ""}`);
  }

  if (opts.outPath !== undefined) {
    const abs = resolve(opts.outPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`wrote ${abs}`);
  }

  let exitCode = summary.failed > 0 ? 1 : 0;

  if (opts.baselinePath !== undefined) {
    const raw: unknown = JSON.parse(await readFile(resolve(opts.baselinePath), "utf8"));
    const baseline = parseEvalRunReport(raw);
    const cmp = compareToBaseline(results, baseline);
    console.log("\n=== Baseline compare");
    for (const d of cmp.deltas) {
      console.log(
        `  ${d.status.padEnd(10)} ${d.id}  prev=${d.previous === null ? "n/a" : d.previous}  now=${d.current}`,
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
