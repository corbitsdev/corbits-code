import { describe, expect, test } from "bun:test";
import type { SendResult } from "@intx/agent";

import { assertReplySend } from "./run.js";

describe("assertReplySend", () => {
  test("passes through a reply result", () => {
    const result: SendResult = {
      type: "reply",
      reply: "done",
      turn: {} as Extract<SendResult, { type: "reply" }>["turn"],
    };
    expect(() => assertReplySend(result)).not.toThrow();
  });

  test("carries the suspension type and correlationId on the thrown error", () => {
    const result: SendResult = {
      type: "suspended",
      correlationId: "corr-123",
    };
    let thrown: unknown;
    try {
      assertReplySend(result);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as Error & {
      suspendedType?: string;
      correlationId?: string;
    };
    expect(error.message).toContain("suspended");
    expect(error.message).toContain("corr-123");
    expect(error.suspendedType).toBe("suspended");
    expect(error.correlationId).toBe("corr-123");
  });

  test("reports when the suspension carries an approval snapshot", () => {
    const snapshot = {
      name: "shell",
      description: "run a shell command",
      inputSchema: { type: "object", properties: {} },
      arguments: {},
    } satisfies NonNullable<
      Extract<SendResult, { type: "suspended" }>["approvalSnapshot"]
    >;
    const result: SendResult = {
      type: "suspended",
      correlationId: "corr-456",
      approvalSnapshot: snapshot,
    };
    let thrown: unknown;
    try {
      assertReplySend(result);
    } catch (err) {
      thrown = err;
    }
    const error = thrown as Error & { approvalSnapshot?: typeof snapshot };
    expect(error.message).toContain("approvalSnapshot present");
    expect(error.approvalSnapshot).toEqual(snapshot);
  });
});
