import { describe, expect, test } from "bun:test";
import { AgentClosedError } from "@intx/agent";
import {
  deliverAgentMessage,
  deliveryResultNotice,
} from "./deliver-agent-message.js";

describe("deliverAgentMessage", () => {
  test("reports session-unavailable without calling deliver when rebuild failed", async () => {
    const fatal = new Error("agent rebuild failed: provider unreachable");
    let delivered = 0;

    const result = await deliverAgentMessage({
      getFatalBuildError: () => fatal,
      deliverToLiveAgent: () => {
        delivered += 1;
      },
    });

    expect(delivered).toBe(0);
    expect(result).toEqual({
      status: "not-delivered",
      reason: "session-unavailable",
      detail: "agent rebuild failed: provider unreachable",
    });
  });

  test("classifies typed AgentClosedError as agent-closed, not by message text", async () => {
    let delivered = 0;

    const result = await deliverAgentMessage({
      getFatalBuildError: () => null,
      deliverToLiveAgent: () => {
        delivered += 1;
        throw new AgentClosedError();
      },
    });

    expect(delivered).toBe(1);
    expect(result.status).toBe("not-delivered");
    if (result.status === "not-delivered") {
      expect(result.reason).toBe("agent-closed");
    }
  });

  test("treats a plain Error whose message says agent is closed as uncertain", async () => {
    const result = await deliverAgentMessage({
      getFatalBuildError: () => null,
      deliverToLiveAgent: () => {
        throw new Error("agent is closed");
      },
    });

    expect(result).toEqual({
      status: "uncertain",
      detail: "agent is closed",
    });
  });

  test("delivers once and returns accepted when the agent is healthy", async () => {
    let delivered = 0;

    const result = await deliverAgentMessage({
      getFatalBuildError: () => null,
      deliverToLiveAgent: () => {
        delivered += 1;
      },
    });

    expect(delivered).toBe(1);
    expect(result).toEqual({ status: "accepted" });
  });
});

describe("deliveryResultNotice", () => {
  test("closed restored and deferred copy is actionable", () => {
    const closed = {
      status: "not-delivered" as const,
      reason: "agent-closed" as const,
      detail: "agent is closed",
    };
    expect(deliveryResultNotice(closed, "restored")).toBe(
      "Message not delivered because the agent closed. It is back in the prompt; press Enter to send it.",
    );
    expect(deliveryResultNotice(closed, "deferred")).toBe(
      "Message not delivered because the agent closed. Your current draft is unchanged; the message will return to the prompt after you send it.",
    );
  });

  test("uncertain copy does not claim nondelivery", () => {
    expect(
      deliveryResultNotice(
        { status: "uncertain", detail: "network reset" },
        "restored",
      ),
    ).toBe(
      "Delivery failed: network reset. Delivery status is uncertain; review the transcript before sending again. It is back in the prompt; press Enter to send it.",
    );
  });
});
