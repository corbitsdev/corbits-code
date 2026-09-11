import { describe, expect, test } from "bun:test";
import { AgentClosedError } from "@intx/agent";
import {
  CLOSED_AGENT_NOTICE,
  CLOSED_AGENT_PROMPT_NOTICE,
  CLOSED_AGENT_QUEUE_NOTICE,
  deliverAgentMessage,
} from "./deliver-agent-message.js";

describe("deliverAgentMessage", () => {
  test("fatal rebuild restores via onClosedWithoutDelivery and never attempts deliver", async () => {
    const notices: string[] = [];
    let restored = false;
    const fatal = new Error("agent rebuild failed: provider unreachable");
    let delivered = false;

    await deliverAgentMessage({
      getFatalBuildError: () => fatal,
      deliverToLiveAgent: () => {
        delivered = true;
      },
      onDeliverFailure: (message) => notices.push(message),
      onClosedWithoutDelivery: () => {
        restored = true;
      },
    });

    expect(delivered).toBe(false);
    expect(restored).toBe(true);
    expect(notices).toEqual([]);
  });

  test("fatal rebuild without restore surfaces the rebuild error", async () => {
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

    expect(delivered).toBe(false);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("not delivered");
    expect(notices[0]).toContain("provider unreachable");
    expect(notices[0]?.toLowerCase()).not.toContain("agent is closed");
  });

  test("AgentClosedError restores operator payload and never says agent is closed", async () => {
    const notices: string[] = [];
    let restored = 0;
    let delivered = 0;

    await deliverAgentMessage({
      getFatalBuildError: () => null,
      deliverToLiveAgent: () => {
        delivered += 1;
        throw new AgentClosedError();
      },
      onDeliverFailure: (message) => notices.push(message),
      onClosedWithoutDelivery: () => {
        restored += 1;
      },
    });

    expect(delivered).toBe(1);
    expect(restored).toBe(1);
    expect(notices).toEqual([]);
  });

  test("AgentClosedError on an internal deliver notices without restoring", async () => {
    const notices: string[] = [];
    let restored = false;

    await deliverAgentMessage({
      getFatalBuildError: () => null,
      deliverToLiveAgent: () => {
        throw new AgentClosedError();
      },
      onDeliverFailure: (message) => notices.push(message),
    });

    expect(restored).toBe(false);
    expect(notices).toEqual([CLOSED_AGENT_NOTICE]);
    expect(notices[0]?.toLowerCase()).not.toContain("agent is closed");
    expect(notices[0]).toContain("not delivered");
  });

  test("unknown throws notice only and do not restore", async () => {
    const notices: string[] = [];
    let restored = false;

    await deliverAgentMessage({
      getFatalBuildError: () => null,
      deliverToLiveAgent: () => {
        throw new Error("socket reset");
      },
      onDeliverFailure: (message) => notices.push(message),
      onClosedWithoutDelivery: () => {
        restored = true;
      },
    });

    expect(restored).toBe(false);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("not delivered");
    expect(notices[0]).toContain("socket reset");
  });

  test("delivers normally and stays silent when the agent is healthy", async () => {
    const notices: string[] = [];
    let delivered = false;
    let restored = false;

    await deliverAgentMessage({
      getFatalBuildError: () => null,
      deliverToLiveAgent: () => {
        delivered = true;
      },
      onDeliverFailure: (message) => notices.push(message),
      onClosedWithoutDelivery: () => {
        restored = true;
      },
    });

    expect(delivered).toBe(true);
    expect(restored).toBe(false);
    expect(notices).toHaveLength(0);
  });

  test("closed-agent notices name the destination and never say agent is closed", () => {
    expect(CLOSED_AGENT_QUEUE_NOTICE).toContain("not delivered");
    expect(CLOSED_AGENT_QUEUE_NOTICE).toContain("back in the queue");
    expect(CLOSED_AGENT_PROMPT_NOTICE).toContain("not delivered");
    expect(CLOSED_AGENT_PROMPT_NOTICE).toContain("back in the prompt");
    expect(CLOSED_AGENT_QUEUE_NOTICE.toLowerCase()).not.toContain(
      "agent is closed",
    );
    expect(CLOSED_AGENT_PROMPT_NOTICE.toLowerCase()).not.toContain(
      "agent is closed",
    );
  });
});
