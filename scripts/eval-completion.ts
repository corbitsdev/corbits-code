#!/usr/bin/env bun
/**
 * CL-7932 task-completion baseline runner.
 *
 * Runs the frozen task set (evals/completion/tasks.json) end to end through
 * the production agent loop with the mock inference stack (no network, no
 * provider credentials): each task's version-controlled responder script
 * plays the model, the real reactor/director/toolset executes, and the
 * task's verify.sh grades the outcome. Reports completion rate plus the
 * control-layer secondary signals (turns, retries, compaction events,
 * doom-loop/thrash interventions, wall clock) as JSON and a human summary.
 *
 * Scripted responders isolate the control layer from model variance on
 * purpose: solve/decline/stall profiles exercise finish, decline, and
 * guard-trip paths deterministically so the 0.4.x re-measure sees the
 * control layer move, not provider noise.
 */

import { cpSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPermissionGate } from "../src/permission/gate.js";
import {
  closeIntegrationSession,
  openIntegrationSession,
  type TurnResult,
} from "../tests/integration/harness.js";
import {
  CompletionReport,
  computeTotals,
  formatSummary,
  isCompletedRun,
  parseResponderScript,
  parseTaskSetFile,
  TaskResult,
  type CompletionTask,
  type RunStatus,
} from "../evals/completion/lib.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const COMPLETION_ROOT = join(REPO_ROOT, "evals", "completion");
const PROVIDER = "stub-scripted";
const MODEL = "completion-baseline-v1";

interface CliOptions {
  tasksPath: string;
  outPath?: string;
  caseId: string;
  repeats: number;
  timeoutMs: number;
  help: boolean;
}

function printUsage(): void {
  console.log(`Usage: bun scripts/eval-completion.ts [options]

  --tasks <path>    Task-set JSON (default: evals/completion/tasks.json)
  --out <path>      Write the JSON report here (default: stdout only)
  --case <id|all>   Run one task or all (default: all)
  --repeats <n>     Repeats per task (default: 2)
  --timeout-ms <n>  Per-run agent wall clock (default: 90000)
  --help            Print this message`);
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    tasksPath: join(COMPLETION_ROOT, "tasks.json"),
    caseId: "all",
    repeats: 2,
    timeoutMs: 90_000,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--tasks" && next !== undefined) {
      opts.tasksPath = resolve(REPO_ROOT, next);
      i++;
    } else if (arg === "--out" && next !== undefined) {
      opts.outPath = resolve(REPO_ROOT, next);
      i++;
    } else if (arg === "--case" && next !== undefined) {
      opts.caseId = next;
      i++;
    } else if (arg === "--repeats" && next !== undefined) {
      opts.repeats = Number.parseInt(next, 10);
      i++;
    } else if (arg === "--timeout-ms" && next !== undefined) {
      opts.timeoutMs = Number.parseInt(next, 10);
      i++;
    } else if (arg === "--help") {
      opts.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(opts.repeats) || opts.repeats < 1) {
    throw new Error(
      `--repeats must be a positive integer, got ${opts.repeats}`,
    );
  }
  return opts;
}

function commitSha(): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error("git rev-parse HEAD failed");
  return result.stdout.trim();
}

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Await the race so the finally below runs on settle, not synchronously
    // on return: clearing the timer before Promise.race settles would make
    // the timeout unreachable and a hung run would hang the harness.
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface PersistedTurn {
  role: string;
}

async function countAssistantTurns(workdir: string): Promise<number | null> {
  try {
    const raw = await readFile(join(workdir, "turns.jsonl"), "utf8");
    const turns = raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as PersistedTurn);
    return turns.filter((turn) => turn.role === "assistant").length;
  } catch {
    return null;
  }
}

const isToolDone = (event: TurnResult["events"][number]) =>
  event.type === "tool.done";
const isToolStart = (event: TurnResult["events"][number]) =>
  event.type === "tool.start";

function deriveSignals(events: TurnResult["events"]) {
  const toolStarts = events.filter(isToolStart);
  const toolDones = events.filter(isToolDone);
  const failedToolCalls = toolDones.filter(
    (event) => event.data.result.isError === true,
  ).length;
  const doomLoopInterventions = events.filter(
    (event) =>
      event.type === "message.run.ended" &&
      event.data.error?.kind === "doom_loop",
  ).length;
  const compactionEvents = events.filter((event) =>
    event.type.toLowerCase().includes("compact"),
  ).length;
  const thrashInterventions = events.filter(
    (event) =>
      event.type.toLowerCase().includes("thrash") ||
      JSON.stringify(event.data).toLowerCase().includes("thrash"),
  ).length;
  const gateSuspensions = events.filter(
    (event) => event.type === "reactor.gate.blocked",
  ).length;
  const runFailed = events.some(
    (event) =>
      event.type === "message.run.ended" && event.data.status === "failed",
  );
  return {
    toolCallCount: toolStarts.length,
    failedToolCalls,
    // Each failed tool call the loop continues past is a retried attempt.
    retryCount: failedToolCalls,
    doomLoopInterventions,
    compactionEvents,
    thrashInterventions,
    gateSuspensions,
    runFailed,
  };
}

async function runTask(
  task: CompletionTask,
  repeat: number,
  timeoutMs: number,
): Promise<TaskResult> {
  const session = await openIntegrationSession({
    permissionGate: createPermissionGate({
      approvals: [],
      interactive: false,
      skipPermissions: true,
      reactorGated: false,
    }),
  });
  const agentStart = Date.now();
  try {
    cpSync(resolve(COMPLETION_ROOT, task.fixture), session.cwd, {
      recursive: true,
    });
    const scriptRaw = await readFile(
      resolve(COMPLETION_ROOT, task.script),
      "utf8",
    );
    const script = parseResponderScript(JSON.parse(scriptRaw));
    for (const turn of script.turns) {
      session.harness.scenario.replyOnce("anthropic", {
        text: turn.text ?? "(no reply text)",
        ...(turn.toolCalls !== undefined ? { toolCalls: turn.toolCalls } : {}),
      });
    }
    let runStatus: RunStatus = "completed";
    let error: string | undefined;
    // Mirror runUntilDone's pump but keep the stream events seen before a
    // throw: guard trips (doom-loop, gate blocks) reject send() while the
    // events that explain them are already on the stream.
    const events: TurnResult["events"] = [];
    const stream = session.agent.stream();
    let turnComplete = false;
    const collect = (async () => {
      for await (const event of stream) {
        events.push(event);
        if (turnComplete && event.type === "message.run.ended") return;
      }
    })().catch(() => undefined);
    try {
      await withTimeout(
        (async () => {
          const sendResult = await Promise.all([
            session.agent.send(task.prompt).then((result) => {
              turnComplete = true;
              return result;
            }),
            session.harness.run({ wallClockBudgetMs: Infinity }),
            collect,
          ]).then(([result]) => result);
          if (sendResult.type !== "reply") {
            throw new Error(`unexpected send outcome: ${sendResult.type}`);
          }
        })(),
        timeoutMs,
        `task ${task.id}`,
      );
    } catch (err) {
      runStatus =
        err instanceof Error && err.message.includes("timed out")
          ? "timeout"
          : "failed";
      error = err instanceof Error ? err.message : String(err);
    }
    const agentDurationMs = Date.now() - agentStart;
    const signals = deriveSignals(events);
    // A guard trip rejects send() without a run.ended event; recover the
    // intervention from the rejection message so it is still counted.
    if (
      error !== undefined &&
      /doom loop/i.test(error) &&
      signals.doomLoopInterventions === 0
    ) {
      signals.doomLoopInterventions = 1;
    }
    if (signals.runFailed) runStatus = "failed";

    const verifyStart = Date.now();
    const verify = spawnSync("bash", [resolve(COMPLETION_ROOT, task.verify)], {
      cwd: session.cwd,
      encoding: "utf8",
      timeout: 60_000,
    });
    const verifyDurationMs = Date.now() - verifyStart;
    const verifyExitCode = verify.status ?? 1;

    const persistedTurns = await countAssistantTurns(session.workdir);
    const turnsUsed =
      persistedTurns ??
      (signals.toolCallCount > 0 ? signals.toolCallCount + 1 : 1);
    const overBudget = turnsUsed > task.maxTurns;
    const completed = isCompletedRun({ runStatus, verifyExitCode, overBudget });
    return TaskResult.assert({
      taskId: task.id,
      title: task.title,
      profile: task.profile,
      repeat,
      completed,
      runStatus,
      turnsUsed,
      toolCallCount: signals.toolCallCount,
      failedToolCalls: signals.failedToolCalls,
      retryCount: signals.retryCount,
      compactionEvents: signals.compactionEvents,
      doomLoopInterventions: signals.doomLoopInterventions,
      thrashInterventions: signals.thrashInterventions,
      gateSuspensions: signals.gateSuspensions,
      agentDurationMs,
      verifyDurationMs,
      verifyExitCode,
      overBudget,
      ...(error !== undefined ? { error } : {}),
    });
  } finally {
    await closeIntegrationSession(session);
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printUsage();
    return;
  }
  const startedAt = new Date().toISOString();
  const taskSet = parseTaskSetFile(
    JSON.parse(await readFile(opts.tasksPath, "utf8")),
  );
  const tasks =
    opts.caseId === "all"
      ? taskSet.tasks
      : taskSet.tasks.filter((task) => task.id === opts.caseId);
  if (tasks.length === 0)
    throw new Error(`No task matches --case ${opts.caseId}`);

  const results: TaskResult[] = [];
  for (const task of tasks) {
    for (let repeat = 0; repeat < opts.repeats; repeat++) {
      const result = await runTask(task, repeat, opts.timeoutMs);
      results.push(result);
      console.log(
        `${result.taskId} r${repeat}: ${result.completed ? "complete" : "incomplete"} ` +
          `(status ${result.runStatus}, turns ${result.turnsUsed}, verify ${result.verifyExitCode}` +
          `${result.error !== undefined ? `, error ${result.error}` : ""})`,
      );
    }
  }

  const report = CompletionReport.assert({
    harness: "completion-baseline",
    version: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    commitSha: commitSha(),
    provider: PROVIDER,
    model: MODEL,
    repeats: opts.repeats,
    taskSetVersion: taskSet.version,
    taskIds: tasks.map((task) => task.id),
    results,
    totals: computeTotals(results),
  });
  const summary = formatSummary(report);
  console.log(`\n${summary}`);
  if (opts.outPath !== undefined) {
    await mkdir(dirname(opts.outPath), { recursive: true });
    await writeFile(opts.outPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Report written to ${opts.outPath}`);
  }
}

if (import.meta.main) {
  await main();
}
