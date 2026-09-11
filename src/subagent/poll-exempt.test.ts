import { describe, expect, test } from "bun:test";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import { isPollOnlyPendingBatch } from "./poll-exempt.js";

function call(name: string, id = "c1"): ToolCall {
  return { id, name, arguments: {} };
}

function result(content: string | Record<string, unknown>): ToolResult {
  return { callId: "c1", content };
}

function waitContent(
  statuses: string[],
  timedOut: boolean,
): Record<string, unknown> {
  return {
    results: statuses.map((status, i) => ({ agent_id: `w${i}`, status })),
    timed_out: timedOut,
  };
}

describe("isPollOnlyPendingBatch", () => {
  test("timed-out wait_agents batch is exempt", () => {
    expect(
      isPollOnlyPendingBatch(
        [call("wait_agents")],
        [result(waitContent(["running"], true))],
      ),
    ).toBe(true);
  });

  test("live wait statuses without timeout are exempt", () => {
    for (const status of ["running", "queued", "awaiting_director"]) {
      expect(
        isPollOnlyPendingBatch(
          [call("wait_agents")],
          [result(waitContent([status], false))],
        ),
      ).toBe(true);
    }
  });

  test("one live entry keeps a mixed-status wait exempt", () => {
    expect(
      isPollOnlyPendingBatch(
        [call("wait_agents")],
        [result(waitContent(["done", "running"], false))],
      ),
    ).toBe(true);
  });

  test("terminal wait_agents batch counts normally", () => {
    for (const statuses of [
      ["done"],
      ["failed"],
      ["interrupted"],
      ["done", "failed"],
      ["unknown"],
      [],
    ]) {
      expect(
        isPollOnlyPendingBatch(
          [call("wait_agents")],
          [result(waitContent(statuses, false))],
        ),
      ).toBe(false);
    }
  });

  test("running shell_collect is exempt; completed or cancelling counts", () => {
    const collect = call("shell_collect");
    expect(
      isPollOnlyPendingBatch(
        [collect],
        [result({ shell_id: "s1", status: "running" })],
      ),
    ).toBe(true);
    for (const status of ["completed", "cancelling"]) {
      expect(
        isPollOnlyPendingBatch([collect], [result({ shell_id: "s1", status })]),
      ).toBe(false);
    }
  });

  test("unparseable or error poll output counts normally", () => {
    expect(
      isPollOnlyPendingBatch(
        [call("wait_agents")],
        [result("Error: timed out waiting")],
      ),
    ).toBe(false);
    expect(
      isPollOnlyPendingBatch(
        [call("shell_collect")],
        [result("No background shell with id s9.")],
      ),
    ).toBe(false);
  });

  test("non-poll calls are never exempt", () => {
    expect(
      isPollOnlyPendingBatch(
        [call("spawn_agent")],
        [result(waitContent(["running"], true))],
      ),
    ).toBe(false);
  });

  test("mixed poll and non-poll batches count normally", () => {
    expect(
      isPollOnlyPendingBatch(
        [call("wait_agents"), call("shell_collect")],
        [
          result(waitContent(["running"], true)),
          result({ shell_id: "s1", status: "running" }),
        ],
      ),
    ).toBe(true);
    expect(
      isPollOnlyPendingBatch(
        [call("wait_agents"), call("read")],
        [
          result(waitContent(["running"], true)),
          result({ shell_id: "s1", status: "running" }),
        ],
      ),
    ).toBe(false);
  });

  test("a settled poll beside a pending poll counts normally", () => {
    expect(
      isPollOnlyPendingBatch(
        [call("wait_agents", "c1"), call("shell_collect", "c2")],
        [
          { callId: "c1", content: waitContent(["done"], false) },
          { callId: "c2", content: { shell_id: "s1", status: "running" } },
        ],
      ),
    ).toBe(false);
  });

  test("empty batches and misaligned results are never exempt", () => {
    expect(isPollOnlyPendingBatch([], [])).toBe(false);
    expect(
      isPollOnlyPendingBatch(
        [call("wait_agents")],
        [
          result(waitContent(["running"], true)),
          result(waitContent(["running"], true)),
        ],
      ),
    ).toBe(false);
  });
});
