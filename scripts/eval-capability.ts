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
import { loadConfig, type Config } from "../src/config/index.js";
import { runExec, resolveExecDirectorOverlay } from "../src/exec/runner.js";
import { SETTINGS_DIR_NAME } from "../src/branding.js";
import {
  codexProfileFromProviderName,
  isCodexProviderName,
} from "../src/config/codex-providers.js";
import {
  REASONING_EFFORTS,
  isReasoningEffort,
  validateEffort,
  type ReasoningEffort,
} from "../src/provider/reasoning-effort.js";
import { codexInstructionsHash } from "../src/auth/codex/instructions.js";
import { advertisedToolNamesForSessionMode } from "../src/agent/tool-search.js";
import { detectLanguageServerAvailable } from "../src/agent/lsp-availability.js";
import { resolveSessionMode } from "../src/config/session-mode.js";
import { loadLocalSettings, localSettingsPath } from "../src/config/settings.js";
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
  checkBehaviorRequirements,
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
  type EvalDiagnostics,
} from "../evals/capability/lib.js";
import {
  deriveBehaviorMetrics,
  parseCapturedRunSummary,
  type BehaviorMetrics,
} from "../evals/capability/behaviors.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CASES_ROOT = join(REPO_ROOT, "evals", "capability", "cases");

interface CliOptions {
  caseSelector: string;
  provider?: string;
  model?: string;
  /** Comma-separated matrix of provider:model cells. */
  matrix?: string;
  /** Reasoning effort applied to every variant that does not specify its own. */
  effort?: ReasoningEffort;
  configPath?: string;
  outPath?: string;
  baselinePath?: string;
  skipPermissions: boolean;
  /** Wall-clock limit for runExec (ms). */
  agentTimeoutMs: number;
  /** Wall-clock limit for verify.sh (ms). */
  verifyTimeoutMs: number;
  /** Runs per case×variant cell (gate runs use 5; freeze runs use 3). */
  repeats: number;
  /** Independent case×variant×repeat cells in parallel (default 1). */
  concurrency: number;
  dryRun: boolean;
  help: boolean;
  /**
   * Allow a run/comparison to proceed when the resolved provider/model
   * differs from what was requested, instead of hard-failing.
   */
  allowProviderFallback: boolean;
  /**
   * Exec overlay: run the product path as this closed-fleet director.
   * Eval/CI override, not single-agent mode. Omitted = skywalker default.
   */
  director?: string;
}

function printUsage(): void {
  console.log(`Usage: bun scripts/eval-capability.ts --provider <name> --model <id> [options]
       bun scripts/eval-capability.ts --matrix <cells> [options]

  --case <id|all>       Case id (default: all)
  --provider <name>     Provider name (required except --help, or --matrix with complete cells)
  --model <id>          Model id (required except --help, or --matrix with complete cells)
  --matrix <cells>      Multi-variant: "p1:m1,p2:m2" or "label=p:m[:effort],..."; each cell needs
                        both provider and model; effort is optional per cell
  --effort <level>      Reasoning effort for variants that don't set their own
                        (${REASONING_EFFORTS.join("|")}); rejected when the
                        target model does not support it
  --config <path>       Settings file override
  --out <path>          Write results JSON
  --baseline <path>     Compare to prior results JSON
  --ask-permissions     Do not pass --dangerously-skip-permissions
  --agent-timeout-ms <n> Wall-clock limit for runExec (default 1200000)
  --verify-timeout-ms <n> Wall-clock limit for verify.sh (default 120000)
  --repeats <n>         Runs per case×variant cell (default 1; gate runs use 5)
  --concurrency <n>     Independent cells in parallel (default 1, env CORBITS_EVAL_CONCURRENCY)
  --dry-run             List cases × variants only (still requires --provider/--model or --matrix)
  --allow-provider-fallback  Allow resolved provider/model to differ from
                             what was requested (default: hard-fail)
  --director <id>       Exec overlay: run as this director (default: skywalker).
                        Eval/CI override, not single-agent mode
  -h, --help            Show help
`);
}

function parsePositiveInteger(raw: string, label: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return n;
}

function defaultConcurrency(): number {
  const raw = process.env.CORBITS_EVAL_CONCURRENCY;
  if (raw === undefined || raw === "") return 1;
  return parsePositiveInteger(raw, "CORBITS_EVAL_CONCURRENCY");
}

/**
 * Run `mapper` over `items` with at most `concurrency` in flight.
 * Results stay in input order even when later items finish first.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new Error("concurrency must be a positive integer");
  }
  if (items.length === 0) return [];
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]!, index);
    }
  };
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = {
    caseSelector: "all",
    skipPermissions: true,
    repeats: 1,
    concurrency: defaultConcurrency(),
    dryRun: false,
    help: false,
    allowProviderFallback: false,
    agentTimeoutMs: Number(process.env.CORBITS_EVAL_AGENT_TIMEOUT_MS ?? 1_200_000),
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
        opts.help = true;
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
      case "--effort": {
        const v = next();
        if (!isReasoningEffort(v)) {
          throw new Error(`--effort must be one of: ${REASONING_EFFORTS.join(", ")}`);
        }
        opts.effort = v;
        break;
      }
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
      case "--concurrency":
        opts.concurrency = parsePositiveInteger(next(), "--concurrency");
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--allow-provider-fallback":
        opts.allowProviderFallback = true;
        break;
      case "--director":
        opts.director = next();
        break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (!opts.help) {
    requireExplicitModelPair(opts);
  }
  return opts;
}

// exactOptionalPropertyTypes forbids passing an explicit `undefined` for an
// optional field, so build the fallback object with the key present only
// when the CLI option was actually given.
function providerModelFallback(opts: CliOptions): {
  provider?: string;
  model?: string;
  effort?: ReasoningEffort;
} {
  return {
    ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
  };
}

function requireExplicitModelPair(opts: CliOptions): void {
  const matrix = opts.matrix?.trim();
  if (matrix !== undefined && matrix.length > 0) {
    parseMatrix(matrix, providerModelFallback(opts));
    return;
  }
  if (!opts.provider && !opts.model) {
    throw new Error("missing required --provider and --model (or --matrix)");
  }
  if (!opts.provider) {
    throw new Error("missing required --provider");
  }
  if (!opts.model) {
    throw new Error("missing required --model");
  }
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
        stderr:
          Buffer.concat(err).toString("utf8") +
          (timedOut ? `\n[eval] timed out after ${timeoutMs}ms` : ""),
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

/** Skill names referenced by global plugins; stubs avoid missing-skill noise in hermetic evals. */
const EVAL_SKILL_STUBS = [
  "style",
  "philosophy",
  "brand-identity",
  "dispatch",
  "interview",
  "typescript",
] as const;

/**
 * Seed minimal skill stubs under `.agents/skills/` so plugin agent skill
 * resolution finds them via project skill dirs. Global plugins reference these
 * names; evals run in a throwaway cwd without marketplace skill trees.
 */
async function seedEvalSkillStubs(workdir: string): Promise<void> {
  for (const name of EVAL_SKILL_STUBS) {
    const skillDir = join(workdir, ".agents", "skills", name);
    await mkdir(skillDir, { recursive: true });
    const body = [
      "---",
      `name: ${name}`,
      `description: Eval stub for ${name} skill.`,
      "---",
      "",
      `Eval stub skill: ${name}.`,
      "",
    ].join("\n");
    await writeFile(join(skillDir, "SKILL.md"), body, "utf8");
  }
}

/**
 * Initialize a git repo in an eval tmp workdir so isolated workers have HEAD
 * and git-aware skills have a baseline. Identity is `git -c`, never env or
 * global config. The fixture commit is unsigned (`--no-gpg-sign`,
 * `-c commit.gpgsign=false`) and skips hooks (`--no-verify`) so operator
 * `commit.gpgsign` / `core.hooksPath` cannot fail or sign with the operator
 * key. Do not call this on source fixtures.
 */
export async function initEvalGitRepo(workdir: string): Promise<void> {
  const identity = ["-c", "user.email=eval@local", "-c", "user.name=eval"] as const;
  const git = async (args: readonly string[]): Promise<void> => {
    const result = await runCommand("git", args, workdir, 30_000);
    if (result.exitCode !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed (${result.exitCode}): ${result.stderr || result.stdout}`,
      );
    }
  };
  await git(["init"]);
  await git([...identity, "add", "-A"]);
  await git([
    ...identity,
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--no-gpg-sign",
    "--no-verify",
    "-m",
    "eval fixture",
  ]);
}

async function prepareWorkdir(
  caseDef: EvalCase,
): Promise<{ workdir: string; capturePath: string }> {
  const fixtureAbs = resolveFixturePath(REPO_ROOT, caseDef.fixture);
  const work = await mkdtemp(join(tmpdir(), `corbits-eval-${caseDef.id}-`));
  await cp(fixtureAbs, work, { recursive: true });
  // Global plugins reference style/philosophy/etc.; evals run in a throwaway
  // cwd without marketplace skill trees, so seed stubs for project skill dirs.
  await seedEvalSkillStubs(work);
  await initEvalGitRepo(work);
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

interface HTTPFixture {
  url: string;
  token: string;
  close: () => Promise<void>;
}

/**
 * Hermetic local page for web-fetch cases: 127.0.0.1 on an ephemeral port,
 * serving a small HTML page with a per-run token. Started and stopped per
 * case run; never left running.
 */
function startHTTPFixture(): Promise<HTTPFixture> {
  const token = randomBytes(8).toString("hex");
  const html =
    "<html><head><title>Release info</title></head>" +
    `<body><h1>Release info</h1><p>build code: <code>${token}</code></p></body></html>`;
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

/**
 * Fail fast, before any inference runs, when a variant's requested reasoning
 * effort is not one the resolved model accepts. Per-model rungs genuinely
 * differ (grok-4.6 takes xhigh, grok-composer-2.5-fast does not; the
 * gpt-5.6 family also takes max/ultra) — silently running at the provider's
 * default instead would poison a matrix without anyone noticing.
 */
export async function validateVariantEfforts(
  variants: readonly EvalVariant[],
  opts: CliOptions,
): Promise<void> {
  for (const variant of variants) {
    if (variant.effort === undefined) continue;
    const labels = await resolveVariantLabels(variant, opts);
    const isCodex = isCodexProviderName(labels.provider);
    const verdict = validateEffort(labels.model, variant.effort, isCodex);
    if (!verdict.ok) {
      throw new Error(
        `variant "${variant.id}" (${labels.provider}/${labels.model}): ${verdict.error}`,
      );
    }
  }
}

/**
 * Write the requested reasoning effort into the fixture workdir's local
 * settings so the product path (loadConfig -> local settings -> Config)
 * picks it up the same way an interactive session would — without ever
 * touching the operator's real ~/.corbits/settings.json.
 */
async function applyEvalEffort(
  workdir: string,
  effort: ReasoningEffort | undefined,
): Promise<void> {
  if (effort === undefined) return;
  const path = localSettingsPath(workdir);
  const existing = await loadLocalSettings(path).catch(() => null);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({ ...existing, reasoningEffort: effort }, null, 2)}\n`,
    "utf8",
  );
}

/**
 * Per-cell diagnostics for debugging eval failures: which Codex instructions
 * text was pinned, which built-in tools the model was offered, and the
 * requested reasoning effort. Reuses the exec runner's own resolution
 * (resolveSessionMode, resolveExecDirectorOverlay) rather than forking the
 * logic, so a --director overlay or a non-default session mode here reports
 * the same advertised list exec actually runs with.
 *
 * reasoningEffort echoes the configured value, not the provider's internal
 * default when unset — accepted as-is per review.
 */
export async function buildEvalDiagnostics(config: Config): Promise<EvalDiagnostics> {
  const codexProfile = codexProfileFromProviderName(config.providerName);
  const localSettings = await loadLocalSettings(localSettingsPath(config.cwd)).catch(() => null);
  const sessionMode = resolveSessionMode(config.settings, localSettings) ?? "orchestrator";
  const overlay = resolveExecDirectorOverlay(config.director);
  const advertisedTools =
    overlay.advertisedAllow ??
    advertisedToolNamesForSessionMode(sessionMode, {
      languageServerAvailable: detectLanguageServerAvailable(config.cwd),
    });
  return {
    codexInstructionsHash: codexProfile !== undefined ? codexInstructionsHash() : null,
    advertisedTools,
    reasoningEffort: config.reasoningEffort ?? null,
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
    skipPermissions: opts.skipPermissions,
    error,
    repeat,
    behaviors: null,
    providerFallback: null,
    diagnostics: null,
    effort: variant.effort ?? null,
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
    await applyEvalEffort(workdir, variant.effort);
    console.log(
      `\n=== ${variant.id} × ${caseDef.id} (${caseDef.tier})` +
        ` [repeat ${repeat + 1}/${opts.repeats}] — ${caseDef.title}`,
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
    if (opts.director !== undefined) argv.push("--director", opts.director);

    argv.push(prompt);

    const config = await loadConfig(argv, { allowUnconfigured: false });
    if (!config.configured) {
      throw new Error(
        "Provider not configured. Pass --provider <name> --model <id> (or --matrix) matching a configured provider.",
      );
    }

    const diagnostics = await buildEvalDiagnostics(config);
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
      ...(requested.provider !== undefined ? { requestedProvider: requested.provider } : {}),
      ...(requested.model !== undefined ? { requestedModel: requested.model } : {}),
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
        `behaviors: shell=${behaviors.shellCommandCount} env=${behaviors.envAssignmentCommandCount}` +
          ` net=${behaviors.networkCommandCount} web_fetch=${behaviors.webFetchToolCallCount}` +
          ` shellEdit=${behaviors.editViaShellCount} repeats=${behaviors.repeatedSearchCount}` +
          ` toolOnlyStreak=${behaviors.longestToolOnlyStreak}` +
          ` maxTurnMs=${behaviors.maxTurnDurationMs}`,
      );
    }

    const requireBehaviorCheck =
      caseDef.requireBehaviors !== undefined && caseDef.requireBehaviors.length > 0
        ? checkBehaviorRequirements(behaviors, caseDef.requireBehaviors)
        : { ok: true, failures: [] as string[] };
    if (!requireBehaviorCheck.ok) {
      for (const failure of requireBehaviorCheck.failures) {
        console.log(`requireBehaviors: ${failure}`);
      }
    }

    const verifyEnv: Record<string, string> =
      httpFixture !== null ? httpFixtureEnv(httpFixture) : {};
    const verify = await runVerify(caseDef, workdir, opts.verifyTimeoutMs, verifyEnv);
    if (verify.output.trim().length > 0) {
      console.log(verify.output.trimEnd());
    }
    console.log(`verify exit: ${verify.exitCode}  (${verify.durationMs}ms)`);

    // requireBehaviors can fail a green agent+verify run (e.g. web-bait honesty).
    const passed = agentExitCode === 0 && verify.exitCode === 0 && requireBehaviorCheck.ok;
    const preview =
      execResult.text.length > 400 ? `${execResult.text.slice(0, 400)}…` : execResult.text;

    let error: string | null = null;
    if (!passed) {
      if (!requireBehaviorCheck.ok) {
        error = requireBehaviorCheck.failures.join("; ");
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

    // Surface require-behavior failures in the text preview so JSON shows why.
    let textPreview = preview;
    if (!requireBehaviorCheck.ok) {
      const reqNote = `requireBehaviors: ${requireBehaviorCheck.failures.join("; ")}`;
      textPreview = textPreview.length > 0 ? `${reqNote}\n${textPreview}` : reqNote;
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
      skipPermissions: opts.skipPermissions,
      error,
      repeat,
      behaviors,
      providerFallback,
      diagnostics,
      effort: variant.effort ?? null,
      textPreview,
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
  return parts.join(" ");
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printUsage();
    return 0;
  }
  const all = await loadEvalCases(CASES_ROOT);
  const selected = filterCases(all, opts.caseSelector);
  const variants = parseMatrix(opts.matrix, providerModelFallback(opts));
  await validateVariantEfforts(variants, opts);
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
  console.log(`Concurrency: ${opts.concurrency}`);

  if (opts.dryRun) {
    console.log("dry-run: no inference");
    for (const { caseDef, variant } of plan) {
      console.log(`  would run: ${variant.id} × ${caseDef.id} × ${opts.repeats} repeat(s)`);
    }
    return 0;
  }

  const startedAt = new Date().toISOString();
  const cells: { caseDef: EvalCase; variant: EvalVariant; repeat: number }[] = [];
  for (const { caseDef, variant } of plan) {
    for (let repeat = 0; repeat < opts.repeats; repeat++) {
      cells.push({ caseDef, variant, repeat });
    }
  }
  const results = await mapPool(cells, opts.concurrency, ({ caseDef, variant, repeat }) =>
    runCase(caseDef, variant, opts, repeat),
  );

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
