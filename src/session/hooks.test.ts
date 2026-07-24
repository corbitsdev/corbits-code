import { describe, expect, test } from "bun:test";
import type { ReactorEmittedEvent } from "@intx/inference";
import { createTurnContextCollector, HOOK_PAYLOAD_TOOL_RESULT_CHARS } from "./hooks.js";

function event(type: string, data: unknown): ReactorEmittedEvent {
  return { type, seq: 1, data } as ReactorEmittedEvent;
}

function observeOneTurnWithToolResult(
  collector: ReturnType<typeof createTurnContextCollector>,
  toolResultContent: string,
): void {
  collector.observe(event("inference.done", {
    turn: {
      role: "assistant",
      content: [{ type: "tool_call", id: "call-1", name: "run_shell", arguments: {} }],
      model: "test",
      timestamp: 0,
    },
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, thinking: 0 },
    source: { provider: "test", model: "test" },
  }));
  collector.observe(event("tool.done", {
    result: { callId: "call-1", content: toolResultContent },
  }));
}

describe("createTurnContextCollector tool result truncation", () => {
  test("retains oversized tool result content within the hook-payload budget", () => {
    const collector = createTurnContextCollector(() => {});
    const hugeOutput = "x".repeat(HOOK_PAYLOAD_TOOL_RESULT_CHARS * 4);

    observeOneTurnWithToolResult(collector, hugeOutput);

    const [turn] = collector.getTurns();
    const content = turn?.toolResults[0]?.content;
    expect(typeof content).toBe("string");
    expect((content as string).length).toBeLessThan(hugeOutput.length);
    expect((content as string).length).toBeLessThanOrEqual(HOOK_PAYLOAD_TOOL_RESULT_CHARS + 64);
  });

  test("leaves tool result content under the budget untouched", () => {
    const collector = createTurnContextCollector(() => {});
    const smallOutput = "exit code 0";

    observeOneTurnWithToolResult(collector, smallOutput);

    const [turn] = collector.getTurns();
    expect(turn?.toolResults[0]?.content).toBe(smallOutput);
  });
});
