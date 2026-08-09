import { describe, expect, test } from "bun:test";
import { deliverAgentMessage } from "./deliver-agent-message.js";

describe("deliverAgentMessage", () => {
  test("surfaces a not-delivered notice instead of throwing when the agent is mid-rebuild", () => {
    const notices: string[] = [];
    const fatal = new Error("agent rebuild failed: provider unreachable");
    let delivered = false;

    deliverAgentMessage({
      getFatalBuildError: () => fatal,
      deliverToLiveAgent: () => {
        delivered = true;
      },
      onDeliverFailure: (message) => notices.push(message),
    });

    // The rebuild failed, so currentAgent still points at the closed agent.
    // Delivery must never be attempted against it, and the operator must see
    // why their message did not go through.
    expect(delivered).toBe(false);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("not delivered");
    expect(notices[0]).toContain("provider unreachable");
  });

  test("surfaces a not-delivered notice when the live agent throws on delivery", () => {
    const notices: string[] = [];

    deliverAgentMessage({
      getFatalBuildError: () => null,
      deliverToLiveAgent: () => {
        throw new Error("agent is closed");
      },
      onDeliverFailure: (message) => notices.push(message),
    });

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("not delivered");
    expect(notices[0]).toContain("agent is closed");
  });

  test("delivers normally and stays silent when the agent is healthy", () => {
    const notices: string[] = [];
    let delivered = false;

    deliverAgentMessage({
      getFatalBuildError: () => null,
      deliverToLiveAgent: () => {
        delivered = true;
      },
      onDeliverFailure: (message) => notices.push(message),
    });

    expect(delivered).toBe(true);
    expect(notices).toHaveLength(0);
  });
});
