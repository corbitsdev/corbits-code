import { describe, expect, test } from "bun:test";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import { isIdempotentTaskBatch } from "./idempotent-task-exempt.js";

function call(name: string, id = "c1"): ToolCall {
  return { id, name, arguments: {} };
}

function taskResult(): ToolResult {
  return { callId: "c1", content: "{}" };
}

describe("isIdempotentTaskBatch", () => {
  test("manage_tasks batch is exempt", () => {
    expect(isIdempotentTaskBatch([call("manage_tasks")], [taskResult()])).toBe(
      true,
    );
  });

  test("todowrite alias is exempt", () => {
    expect(isIdempotentTaskBatch([call("todowrite")], [taskResult()])).toBe(
      true,
    );
  });

  test("update_plan hidden alias is exempt", () => {
    expect(isIdempotentTaskBatch([call("update_plan")], [taskResult()])).toBe(
      true,
    );
  });

  test("repeated task-only batches stay exempt", () => {
    expect(
      isIdempotentTaskBatch(
        [call("todowrite", "c1"), call("todowrite", "c2")],
        [taskResult(), { callId: "c2", content: "{}" }],
      ),
    ).toBe(true);
  });

  test("a real tool in the batch is never exempt", () => {
    expect(
      isIdempotentTaskBatch(
        [call("todowrite"), call("run_shell")],
        [taskResult(), { callId: "c2", content: "{}" }],
      ),
    ).toBe(false);
  });

  test("non-task tools are never exempt", () => {
    expect(isIdempotentTaskBatch([call("run_shell")], [taskResult()])).toBe(
      false,
    );
  });

  test("empty batches are never exempt", () => {
    expect(isIdempotentTaskBatch([], [])).toBe(false);
  });
});
