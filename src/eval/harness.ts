import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../config.js";
import { runAgent } from "../run-agent.js";
import { createTurnContextCollector } from "../hooks.js";
import { loadPricing, type PricingCache } from "../pricing-fetcher.js";
import { computeCost, medianMetrics, tallyToolCalls } from "./metrics.js";
import type { EvalTask, RunMetrics, Variant } from "./types.js";

const VERIFY_TIMEOUT_MS = 300_000;

// Run the task's verify.sh against the (now agent-modified) copy. Exit 0 = the
// objective grader passed. The whole task dir is copied to temp so verify.sh —
// which cd's into its sibling repo/ — grades the modified copy, not the pristine
// original.
async function runVerify(taskCopyDir: string): Promise<boolean> {
  // stdout/stderr are "ignore": the harness does not read them, and leaving them
  // as unread pipes risks the child deadlocking once the OS pipe buffer fills on
  // a verbose grader.
  const proc = Bun.spawn(["bash", "verify.sh"], {
    cwd: taskCopyDir,
    stdout: "ignore",
    stderr: "ignore",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<number>((resolve) => {
    timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // ignore
      }
      resolve(-1);
    }, VERIFY_TIMEOUT_MS);
  });
  try {
    const exitCode = await Promise.race([proc.exited, timeout]);
    return exitCode === 0;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// Run one task under one variant, once, in an isolated temp copy. Captures the
// same metrics the runtime already computes (via its turn collector) plus the
// objective verify.sh result. Reuses runAgent's onEvent hook so no runtime code
// changes are needed.
export async function runTaskOnce(
  task: EvalTask,
  variant: Variant,
  pricingCache: PricingCache | null,
): Promise<RunMetrics> {
  const workDir = await mkdtemp(join(tmpdir(), `eval-${task.name}-`));
  try {
    await cp(task.dir, workDir, { recursive: true });
    const repoDir = join(workDir, "repo");
    const prompt = (await readFile(join(workDir, "prompt.txt"), "utf8")).trim();

    const argv = ["--cwd", repoDir, "--config", variant.configPath];
    if (variant.provider !== undefined) argv.push("--provider", variant.provider);
    if (variant.model !== undefined) argv.push("--model", variant.model);
    // Eval runs are headless: there is no operator to approve consequential
    // tool calls, so the permission gate must be bypassed (the secret-guard and
    // authz hard-denies still hold). --force overrides any stale run state.
    argv.push("--dangerously-skip-permissions", "--force", prompt);

    const config = await loadConfig(argv);
    const collector = createTurnContextCollector(() => {});

    // Wall-clock spans the whole headless run INCLUDING runAgent's post-run
    // critique gate (build/typecheck/test), not just agent inference. For these
    // small task repos that is mostly the test run; treat wall-clock as
    // end-to-end run latency, not pure model latency.
    const startedAt = Date.now();
    let crashed = false;
    let exitCode = 1;
    try {
      exitCode = await runAgent(config, startedAt, undefined, (event) => collector.observe(event));
    } catch {
      // A thrown run (e.g. inference error) still counts — it simply fails
      // verify. Metrics gathered so far remain meaningful.
      crashed = true;
    }
    const wallClockMs = Date.now() - startedAt;
    // The runtime's own verdict on the run (0 = clean: agent finished and its
    // critique passed). Distinct from `passed`, which is verify.sh's objective
    // grade — a run can finish cleanly yet still fail the task's own tests.
    const completedCleanly = !crashed && exitCode === 0;

    const passed = crashed ? false : await runVerify(workDir);

    const turns = collector.getTurns();
    const tokens = collector.getTokenUsage();
    const totalTokens =
      tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite + tokens.thinking;

    return {
      task: task.name,
      variant: variant.name,
      turns: turns.length,
      toolCalls: collector.getToolCallCount(),
      toolCallsByType: tallyToolCalls(turns),
      tokens,
      totalTokens,
      cost: computeCost(tokens, config.model, pricingCache, variant.priceOverride),
      wallClockMs,
      passed,
      completedCleanly,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

// Run a task under a variant N times and collapse to a representative result.
export async function runTask(
  task: EvalTask,
  variant: Variant,
  pricingCache: PricingCache | null,
  runs = 1,
): Promise<RunMetrics> {
  const results: RunMetrics[] = [];
  for (let i = 0; i < runs; i++) {
    results.push(await runTaskOnce(task, variant, pricingCache));
  }
  return medianMetrics(results);
}

// Run the full task list under two variants for an A/B comparison. Pricing is
// loaded once and shared across runs.
export async function runSuite(
  tasks: EvalTask[],
  variantA: Variant,
  variantB: Variant,
  runs = 1,
): Promise<{ a: RunMetrics[]; b: RunMetrics[] }> {
  const pricingCache = await loadPricing();
  const a: RunMetrics[] = [];
  const b: RunMetrics[] = [];
  for (const task of tasks) {
    a.push(await runTask(task, variantA, pricingCache, runs));
    b.push(await runTask(task, variantB, pricingCache, runs));
  }
  return { a, b };
}
