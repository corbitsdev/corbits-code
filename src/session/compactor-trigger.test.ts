import { describe, expect, test } from "bun:test";
import { createPruningCompactor } from "./compactor.js";
import type {
  ConversationTurn,
  ReactorState,
  StrategyContext,
} from "@intx/types/runtime";

function ctx(trigger: string): StrategyContext {
  return { state: {} as ReactorState, trigger };
}

function textTurn(
  role: ConversationTurn["role"],
  text: string,
): ConversationTurn {
  return {
    role,
    content: [{ type: "text", text }],
    timestamp: 1,
  };
}

// Bodies exceed the pinned tail budget so apply() takes the fold path.
function foldableTurns(): ConversationTurn[] {
  const body = (label: string): string => `${label} ${"x".repeat(120)}`;
  return [
    textTurn("user", body("old message 1")),
    textTurn("assistant", body("old response 1")),
    textTurn("user", body("old message 2")),
    textTurn("assistant", body("old response 2")),
    textTurn("user", "recent message"),
    textTurn("assistant", "recent response"),
  ];
}

function compactor(
  summarize?: (turns: ConversationTurn[]) => Promise<string>,
): ReturnType<typeof createPruningCompactor> {
  return createPruningCompactor({
    summaryMaxChars: 2000,
    compactionShape: { tailBudgetTokens: 10 },
    ...(summarize !== undefined ? { summarize } : {}),
  });
}

describe("pruning compactor persists invocation trigger (CL-10869)", () => {
  test.each(["director:operator-request", "director:context-threshold"])(
    "a real fold records %s without rewriting the human reason",
    async (trigger) => {
      const result = await compactor().apply(foldableTurns(), ctx(trigger));
      expect(result.record.reason).toMatch(
        /^compacted \d+ turns, keeping \d+ tail$/,
      );
      expect(result.record.reason).not.toContain("director:");
      expect(result.record.decisions.trigger).toBe(trigger);
    },
  );

  test("a verify keep-prior record carries the trigger that was passed", async () => {
    const trigger = "director:context-overflow";
    const turns: ConversationTurn[] = [
      textTurn(
        "user",
        "Migrate the auth module to opaque tokens in src/auth.ts",
      ),
      textTurn("assistant", "Reading the handler first."),
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "c1",
            name: "run_shell",
            arguments: { command: "bun run test auth" },
          },
        ],
        timestamp: 3,
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            callId: "c1",
            isError: true,
            content: [{ type: "text", text: "token refresh assertion failed" }],
          },
        ],
        timestamp: 4,
      },
      textTurn("assistant", "Fix the token refresh assertion next."),
      textTurn("user", "recent ask"),
      textTurn("assistant", "recent reply"),
    ];
    const result = await compactor(
      async () => "Auth migration done. No errors remain.",
    ).apply(turns, ctx(trigger));
    expect(result.output).toBe(turns);
    expect(result.record.reason).toBe("verify failed — keeping prior context");
    expect(result.record.decisions.verifyAbortReason).toBe("contradiction");
    expect(result.record.decisions.trigger).toBe(trigger);
  });
});
