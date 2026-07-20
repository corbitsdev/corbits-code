import { describe, expect, test } from "bun:test";
import {
  DEFAULT_GOAL_APPROVAL_TIMEOUT_MS,
  goalApprovalTimeoutMessage,
  isGoalApprovalTimeoutActive,
} from "./goal-approval-timeout.js";

describe("goal approval timeout helpers", () => {
  test("only active goals arm the timeout", () => {
    expect(isGoalApprovalTimeoutActive("active")).toBe(true);
    expect(isGoalApprovalTimeoutActive("paused")).toBe(false);
    expect(isGoalApprovalTimeoutActive("budget_limited")).toBe(false);
    expect(isGoalApprovalTimeoutActive("inactive")).toBe(false);
    expect(isGoalApprovalTimeoutActive("cleared")).toBe(false);
    expect(isGoalApprovalTimeoutActive(null)).toBe(false);
    expect(isGoalApprovalTimeoutActive(undefined)).toBe(false);
  });

  test("default timeout is 15s", () => {
    expect(DEFAULT_GOAL_APPROVAL_TIMEOUT_MS).toBe(15_000);
  });

  test("timeout message tells the agent to skip and continue", () => {
    const msg = goalApprovalTimeoutMessage(15_000);
    expect(msg).toContain("15s");
    expect(msg.toLowerCase()).toContain("human may be away");
    expect(msg.toLowerCase()).toContain("skipped");
    expect(msg.toLowerCase()).toContain("do not retry");
  });
});
