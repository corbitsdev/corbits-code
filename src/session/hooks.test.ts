import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReactorEmittedEvent } from "@intx/inference";
import type { LastCycleSource, TokenUsage } from "@intx/types/runtime";
import {
  CREDENTIAL_REDACTION,
  scrubSecretShapedValue,
} from "../plugins/tool-result-secret-scrub.js";
import {
  createLifecycleHookManager,
  createRunSummary,
  createTurnContextCollector,
  discoverLifecycleHooks,
  hookDirectories,
  HOOK_PAYLOAD_TOOL_RESULT_CHARS,
  localHooksDirectory,
  type LifecycleHookEvent,
  type RunSummary,
} from "./hooks.js";

function event(type: string, data: unknown): ReactorEmittedEvent {
  return { type, seq: 1, data } as ReactorEmittedEvent;
}

function observeOneTurnWithToolResult(
  collector: ReturnType<typeof createTurnContextCollector>,
  toolResultContent: string,
  toolResultDetail?: unknown,
): void {
  collector.observe(
    event("inference.done", {
      turn: {
        role: "assistant",
        content: [
          { type: "tool_call", id: "call-1", name: "run_shell", arguments: {} },
        ],
        model: "test",
        timestamp: 0,
      },
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, thinking: 0 },
      source: { provider: "test", model: "test" },
    }),
  );
  collector.observe(
    event("tool.done", {
      result: {
        callId: "call-1",
        content: toolResultContent,
        ...(toolResultDetail !== undefined ? { detail: toolResultDetail } : {}),
      },
    }),
  );
}

describe("createTurnContextCollector tool result truncation", () => {
  test("retains oversized tool result content within the hook-payload budget", () => {
    const collector = createTurnContextCollector(() => undefined);
    const hugeOutput = "x".repeat(HOOK_PAYLOAD_TOOL_RESULT_CHARS * 4);

    observeOneTurnWithToolResult(collector, hugeOutput);

    const [turn] = collector.getTurns();
    const content = turn?.toolResults[0]?.content;
    expect(typeof content).toBe("string");
    expect((content as string).length).toBeLessThan(hugeOutput.length);
    expect((content as string).length).toBeLessThanOrEqual(
      HOOK_PAYLOAD_TOOL_RESULT_CHARS + 64,
    );
  });

  test("leaves tool result content under the budget untouched", () => {
    const collector = createTurnContextCollector(() => undefined);
    const smallOutput = "exit code 0";

    observeOneTurnWithToolResult(collector, smallOutput);

    const [turn] = collector.getTurns();
    expect(turn?.toolResults[0]?.content).toBe(smallOutput);
  });

  test("preserves small structured detail in hook payloads", () => {
    const collector = createTurnContextCollector(() => undefined);
    const detail = { answer: 42 };

    observeOneTurnWithToolResult(collector, "exit code 0", detail);

    const [turn] = collector.getTurns();
    expect(turn?.toolResults[0]?.detail).toEqual(detail);
  });

  test("retained hook payloads do not expose credential-shaped detail keys", () => {
    const collector = createTurnContextCollector(() => undefined);
    const rawKey = ["sk-", "live-", "h".repeat(24)].join("");
    const detail = scrubSecretShapedValue({ [rawKey]: "value" });

    observeOneTurnWithToolResult(collector, "exit code 0", detail);

    const payload = JSON.stringify(collector.getTurns()[0]);
    expect(payload).toContain(CREDENTIAL_REDACTION);
    expect(payload).not.toContain(rawKey);
  });

  test("retained hook payloads redact short credential-keyed values", () => {
    const collector = createTurnContextCollector(() => undefined);
    const detail = scrubSecretShapedValue({
      apiKey: "top-short",
      nested: { auth: "nested-short" },
    });

    observeOneTurnWithToolResult(collector, "exit code 0", detail);

    const payload = JSON.stringify(collector.getTurns()[0]);
    expect(payload).toContain(CREDENTIAL_REDACTION);
    expect(payload).not.toContain("top-short");
    expect(payload).not.toContain("nested-short");
  });

  test("omits oversized structured detail while keeping the content cap", () => {
    const collector = createTurnContextCollector(() => undefined);
    const hugeOutput = "x".repeat(HOOK_PAYLOAD_TOOL_RESULT_CHARS * 4);
    const hugeDetail = { blob: "y".repeat(HOOK_PAYLOAD_TOOL_RESULT_CHARS * 4) };

    observeOneTurnWithToolResult(collector, hugeOutput, hugeDetail);

    const [turn] = collector.getTurns();
    const result = turn?.toolResults[0];
    expect(result?.detail).toBeUndefined();
    const content = result?.content;
    expect(typeof content).toBe("string");
    expect((content as string).length).toBeLessThanOrEqual(
      HOOK_PAYLOAD_TOOL_RESULT_CHARS + 64,
    );
    expect(JSON.stringify(turn).length).toBeLessThanOrEqual(
      HOOK_PAYLOAD_TOOL_RESULT_CHARS + 512,
    );
  });
});

describe("lifecycle hook payload delivery", () => {
  test("a hook that exits without reading a large payload is a hook outcome, not a crash", async () => {
    // A postTurn-only shell hook exits at once on postRun; the long-session run summary exceeds the pipe buffer, so the write lands on a closed pipe.
    const directory = await mkdtemp(join(tmpdir(), "corbits-hook-"));
    const path = join(directory, "post-turn-only.sh");
    await writeFile(path, 'case "$1" in postTurn) cat > /dev/null ;; esac\n');
    const errors: string[] = [];
    const manager = createLifecycleHookManager({
      hooks: [{ id: path, name: "post-turn-only.sh", type: "shell", path }],
      logError: (message) => errors.push(message),
    });
    const summary: RunSummary = {
      task: "x".repeat(2_000_000),
      status: "done",
      startedAt: 0,
      finishedAt: 1,
      durationMs: 1,
      turnsUsed: 0,
      tokenUsage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        thinking: 0,
      },
      turns: [],
      toolCallCount: 0,
    };
    let unhandled: unknown = null;
    const onUnhandled = (reason: unknown) => {
      unhandled = reason;
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      await manager.dispatchPostRun(summary);
      await new Promise((resolve) => setTimeout(resolve, 40));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    // Whether the pipe breaks before buffering varies; neither outcome may take the process down.
    expect(unhandled).toBeNull();
    expect(errors).toEqual([]);
    const [status] = manager.getStatuses();
    expect(status?.lastExitStatus?.code).toBe(0);
  });
});

const usage: TokenUsage = {
  input: 2,
  output: 3,
  cacheRead: 5,
  cacheWrite: 7,
  thinking: 11,
};

const source: LastCycleSource = {
  sourceId: "test-source",
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
  const hooks = await discoverLifecycleHooks(
    join(tmpdir(), "missing-interchange-hooks"),
  );
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
  expect(hooks.find((hook) => hook.name === "shared.ts")?.path).toBe(
    join(local, "shared.ts"),
  );
});

test("hookDirectories resolves local hooks from the configured cwd", () => {
  const cwd = join(tmpdir(), "interchange-target-cwd");

  expect(localHooksDirectory(cwd)).toBe(join(cwd, ".corbits", "hooks"));
  expect(hookDirectories(cwd)[0]).toBe(join(cwd, ".corbits", "hooks"));
});

test("createTurnContextCollector emits a turn after inference without tools", () => {
  const turns: unknown[] = [];
  const collector = createTurnContextCollector(
    (ctx) => turns.push(ctx),
    makeClock([0, 0, 50, 50]),
  );

  collector.observe({
    type: "inference.start",
    seq: 1,
    data: { model: "test-model" },
  });
  collector.observe(inferenceDoneEvent(0));

  expect(turns.length).toBe(1);
  expect(collector.getTurns()[0]?.turnIndex).toBe(0);
  expect(collector.getTurns()[0]?.toolCalls).toEqual([]);
  expect(collector.getTurns()[0]?.durationMs).toBe(50);
  expect(collector.getTokenUsage()).toEqual(usage);
});

test("createTurnContextCollector waits for every tool result before emitting", () => {
  const turns: unknown[] = [];
  const collector = createTurnContextCollector(
    (ctx) => turns.push(ctx),
    makeClock([0, 0, 20, 20]),
  );

  collector.observe({
    type: "inference.start",
    seq: 1,
    data: { model: "test-model" },
  });
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
    hooks: [
      { id: hookPath, name: "record.ts", type: "typescript", path: hookPath },
    ],
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

  await waitFor(() =>
    events.some(
      (event) =>
        event.type === "hook.updated" &&
        event.hook.lastExitStatus !== undefined,
    ),
  );
  const written = JSON.parse(await readFile(outputPath, "utf8")) as {
    turnIndex?: unknown;
  };
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

test("createLifecycleHookManager seeds enabled from initialEnabled, defaulting to true when absent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "interchange-hooks-"));
  const a = join(dir, "a.sh");
  const b = join(dir, "b.sh");
  await writeFile(a, "true\n");
  await writeFile(b, "true\n");

  const manager = createLifecycleHookManager({
    hooks: [
      { id: a, name: "a.sh", type: "shell", path: a },
      { id: b, name: "b.sh", type: "shell", path: b },
    ],
    initialEnabled: { [a]: false },
  });

  const statuses = manager.getStatuses();
  expect(statuses.find((s) => s.id === a)?.enabled).toBe(false);
  expect(statuses.find((s) => s.id === b)?.enabled).toBe(true);
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

  const written = JSON.parse(await readFile(outputPath, "utf8")) as {
    task?: unknown;
  };
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
