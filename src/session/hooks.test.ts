import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReactorEmittedEvent } from "@intx/inference";
import {
  createLifecycleHookManager,
  createTurnContextCollector,
  HOOK_PAYLOAD_TOOL_RESULT_CHARS,
  type RunSummary,
} from "./hooks.js";

function event(type: string, data: unknown): ReactorEmittedEvent {
  return { type, seq: 1, data } as ReactorEmittedEvent;
}

function observeOneTurnWithToolResult(
  collector: ReturnType<typeof createTurnContextCollector>,
  toolResultContent: string,
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
      result: { callId: "call-1", content: toolResultContent },
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
});

describe("lifecycle hook payload delivery", () => {
  test("a hook that exits without reading a large payload is a hook outcome, not a crash", async () => {
    // A shell hook that handles only postTurn exits at once on postRun; the
    // run summary of a long session is megabytes, far past what the pipe
    // buffers, so the write lands on a closed pipe.
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
    // Whether the pipe breaks before the payload is buffered varies run to
    // run; what must not vary is that neither outcome takes the process down.
    expect(unhandled).toBeNull();
    expect(errors).toEqual([]);
    const [status] = manager.getStatuses();
    expect(status?.lastExitStatus?.code).toBe(0);
  });
});
