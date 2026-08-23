import { describe, expect, test } from "bun:test";
import { deliverAgentMessage } from "./deliver-agent-message.js";

describe("deliverAgentMessage", () => {
  test("surfaces a not-delivered notice instead of throwing when the agent is mid-rebuild", async () => {
    const notices: string[] = [];
    const fatal = new Error("agent rebuild failed: provider unreachable");
    let delivered = false;

    await deliverAgentMessage({
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

  test("surfaces a not-delivered notice when the live agent throws on delivery", async () => {
    const notices: string[] = [];

    await deliverAgentMessage({
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

  test("delivers normally and stays silent when the agent is healthy", async () => {
    const notices: string[] = [];
    let delivered = false;

    await deliverAgentMessage({
      getFatalBuildError: () => null,
      deliverToLiveAgent: () => {
        delivered = true;
      },
      onDeliverFailure: (message) => notices.push(message),
    });

    expect(delivered).toBe(true);
    expect(notices).toHaveLength(0);
  });

  test("holds delivery until ready settles so the first request cannot race startup work", async () => {
    // Models the Codex instructions refresh: the request body prefix pins the
    // instructions text, so delivery — and therefore request building — must
    // wait for the in-flight refresh instead of letting it swap the value
    // between turn 1 and turn 2.
    let instructions = "cached";
    let observedAtDelivery = "";
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });

    const pending = deliverAgentMessage({
      getFatalBuildError: () => null,
      ready,
      deliverToLiveAgent: () => {
        observedAtDelivery = instructions;
      },
      onDeliverFailure: () => undefined,
    });

    // Refresh still in flight: nothing delivered yet.
    await Promise.resolve();
    expect(observedAtDelivery).toBe("");

    instructions = "refreshed";
    resolveReady();
    await pending;

    // The first request observed the post-refresh value, so a later-settling
    // refresh can never change the prefix of an already-started session.
    expect(observedAtDelivery).toBe("refreshed");
  });

  test("delivers immediately when ready is already settled", async () => {
    let delivered = false;

    await deliverAgentMessage({
      getFatalBuildError: () => null,
      ready: Promise.resolve(),
      deliverToLiveAgent: () => {
        delivered = true;
      },
      onDeliverFailure: () => undefined,
    });

    expect(delivered).toBe(true);
  });
});
