import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { expect, test } from "bun:test";
import type { ReactorEmittedEvent } from "@intx/inference";
import type { LastCycleSource, TokenUsage } from "@intx/types/runtime";

import {
  createLifecycleHookManager,
  createRunSummary,
  createTurnContextCollector,
  discoverLifecycleHooks,
  hookDirectories,
  localHooksDirectory,
  type LifecycleHookEvent,
} from "../../src/session/hooks.js";

const usage: TokenUsage = {
  input: 2,
  output: 3,
  cacheRead: 5,
  cacheWrite: 7,
  thinking: 11,
};

const source: LastCycleSource = {
  id: "test-source",
  provider: "openai",
  model: "test-model",
};

function inferenceDoneEvent(toolCallCount: number): ReactorEmittedEvent {
  return {
    type: "inference.done",
    seq: 1,
    data: {
      turn: {
        role: "assistant",
        timestamp: 0,
        model: "test-model",
        content: Array.from({ length: toolCallCount }, (_, i) => ({
          type: "tool_call",
          id: `call-${i}`,
          name: "read_file",
          arguments: { path: `file-${i}.ts` },
        })),
      },
      usage,
      source,
    },
  };
}

test("discoverLifecycleHooks finds supported hook files in stable order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "interchange-hooks-"));
  await writeFile(join(dir, "b.sh"), "echo shell");
  await writeFile(join(dir, "a.ts"), "export function postTurn() {}");
  await writeFile(join(dir, "ignored.txt"), "nope");

  const hooks = await discoverLifecycleHooks(dir);

  expect(hooks.map((hook) => hook.name)).toEqual(["a.ts", "b.sh"]);
  expect(hooks.map((hook) => hook.type)).toEqual(["typescript", "shell"]);
});

test("discoverLifecycleHooks treats a missing directory as no hooks", async () => {
  const hooks = await discoverLifecycleHooks(join(tmpdir(), "missing-interchange-hooks"));
  expect(hooks).toEqual([]);
});

test("discoverLifecycleHooks gives local hooks precedence over global hooks", async () => {
  const root = await mkdtemp(join(tmpdir(), "interchange-hooks-"));
  const local = join(root, "local");
  const global = join(root, "global");
  await mkdir(local);
  await mkdir(global);
  await writeFile(join(local, "shared.ts"), "export function postTurn() {}");
  await writeFile(join(global, "shared.ts"), "export function postRun() {}");
  await writeFile(join(global, "global.sh"), "echo shell");

  const hooks = await discoverLifecycleHooks([local, global]);

  expect(hooks.map((hook) => hook.name)).toEqual(["shared.ts", "global.sh"]);
  expect(hooks.find((hook) => hook.name === "shared.ts")?.path).toBe(join(local, "shared.ts"));
});

test("hookDirectories resolves local hooks from the configured cwd", () => {
  const cwd = join(tmpdir(), "interchange-target-cwd");

  expect(localHooksDirectory(cwd)).toBe(join(cwd, ".corbits", "hooks"));
  expect(hookDirectories(cwd)[0]).toBe(join(cwd, ".corbits", "hooks"));
});

test("createTurnContextCollector emits a turn after inference without tools", () => {
  const turns: unknown[] = [];
  const collector = createTurnContextCollector((ctx) => turns.push(ctx), makeClock([0, 0, 50, 50]));

  collector.observe({ type: "inference.start", seq: 1, data: { model: "test-model" } });
  collector.observe(inferenceDoneEvent(0));

  expect(turns.length).toBe(1);
  expect(collector.getTurns()[0]?.turnIndex).toBe(0);
  expect(collector.getTurns()[0]?.toolCalls).toEqual([]);
  expect(collector.getTurns()[0]?.durationMs).toBe(50);
  expect(collector.getTokenUsage()).toEqual(usage);
});

test("createTurnContextCollector waits for every tool result before emitting", () => {
  const turns: unknown[] = [];
  const collector = createTurnContextCollector((ctx) => turns.push(ctx), makeClock([0, 0, 20, 20]));

  collector.observe({ type: "inference.start", seq: 1, data: { model: "test-model" } });
  collector.observe(inferenceDoneEvent(2));
  expect(turns.length).toBe(0);

  collector.observe({
    type: "tool.done",
    seq: 2,
    data: { result: { callId: "call-0", content: "ok", isError: false } },
  });
  expect(turns.length).toBe(0);

  collector.observe({
    type: "tool.done",
    seq: 3,
    data: { result: { callId: "call-1", content: "bad", isError: true } },
  });

  const turn = collector.getTurns()[0];
  expect(turns.length).toBe(1);
  expect(turn?.toolCalls.length).toBe(2);
  expect(turn?.toolResults.length).toBe(2);
  expect(turn?.durationMs).toBe(20);
  expect(collector.getToolCallCount()).toBe(2);
});

test("createRunSummary derives duration and carries accumulated turn data", () => {
  const summary = createRunSummary({
    task: "do work",
    status: "done",
    startedAt: 100,
    finishedAt: 175,
    turnsUsed: 1,
    tokenUsage: usage,
    turns: [],
    toolCallCount: 3,
  });

  expect(summary.durationMs).toBe(75);
  expect(summary.task).toBe("do work");
  expect(summary.toolCallCount).toBe(3);
  expect(summary.error).toBeUndefined();
});

test("createRunSummary supports cancelled runs", () => {
  const summary = createRunSummary({
    task: "do work",
    status: "cancelled",
    startedAt: 100,
    finishedAt: 175,
    turnsUsed: 1,
    tokenUsage: usage,
    turns: [],
    toolCallCount: 3,
  });

  expect(summary.status).toBe("cancelled");
});

test("createLifecycleHookManager executes TypeScript hooks and reports status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "interchange-hooks-"));
  const outputPath = join(dir, "output.json");
  const hookPath = join(dir, "record.ts");
  await writeFile(
    hookPath,
    [
      "import { writeFile } from 'node:fs/promises';",
      "export async function postTurn(ctx: unknown) {",
      `  await writeFile(${JSON.stringify(outputPath)}, JSON.stringify(ctx));`,
      "}",
    ].join("\n"),
  );

  const events: LifecycleHookEvent[] = [];
  const manager = createLifecycleHookManager({
    hooks: [{ id: hookPath, name: "record.ts", type: "typescript", path: hookPath }],
    onEvent: (event) => events.push(event),
  });

  manager.dispatchPostTurn({
    turnIndex: 0,
    assistantTurn: { role: "assistant", timestamp: 0, content: [] },
    toolCalls: [],
    toolResults: [],
    usage,
    source,
    durationMs: 1,
  });

  await waitFor(() => events.some((event) => event.type === "hook.updated" && event.hook.lastExitStatus !== undefined));
  const written = JSON.parse(await readFile(outputPath, "utf8")) as { turnIndex?: unknown };
  expect(written.turnIndex).toBe(0);
  expect(manager.getStatuses()[0]?.lastExitStatus?.code).toBe(0);
});

test("createLifecycleHookManager can disable hooks per run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "interchange-hooks-"));
  const outputPath = join(dir, "output.json");
  const hookPath = join(dir, "record.sh");
  await writeFile(hookPath, `cat > ${JSON.stringify(outputPath)}\n`);

  const manager = createLifecycleHookManager({
    hooks: [{ id: hookPath, name: "record.sh", type: "shell", path: hookPath }],
  });
  manager.setEnabled(hookPath, false);
  await manager.dispatchPostRun(
    createRunSummary({
      task: "x",
      status: "done",
      startedAt: 0,
      finishedAt: 1,
      turnsUsed: 0,
      tokenUsage: usage,
      turns: [],
      toolCallCount: 0,
    }),
  );

  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(manager.getStatuses()[0]?.lastFiredAt).toBeUndefined();
});

test("createLifecycleHookManager waits for postRun hooks to finish", async () => {
  const dir = await mkdtemp(join(tmpdir(), "interchange-hooks-"));
  const outputPath = join(dir, "output.json");
  const hookPath = join(dir, "record.sh");
  await writeFile(hookPath, `cat > ${JSON.stringify(outputPath)}\n`);

  const manager = createLifecycleHookManager({
    hooks: [{ id: hookPath, name: "record.sh", type: "shell", path: hookPath }],
  });

  await manager.dispatchPostRun(
    createRunSummary({
      task: "x",
      status: "done",
      startedAt: 0,
      finishedAt: 1,
      turnsUsed: 0,
      tokenUsage: usage,
      turns: [],
      toolCallCount: 0,
    }),
  );

  const written = JSON.parse(await readFile(outputPath, "utf8")) as { task?: unknown };
  expect(written.task).toBe("x");
  expect(manager.getStatuses()[0]?.lastExitStatus?.code).toBe(0);
});

function makeClock(values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}

async function waitFor(assertion: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!assertion()) {
    if (Date.now() - startedAt > 5_000) {
      throw new Error("timed out waiting for assertion");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
