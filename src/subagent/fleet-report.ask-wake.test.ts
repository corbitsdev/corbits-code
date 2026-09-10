import { describe, expect, test } from "bun:test";
import {
  pendingAskSnapshot,
  pendingAskWakeText,
  type FleetLane,
} from "./fleet-report.js";

function lane(overrides: Partial<FleetLane> & { id: string }): FleetLane {
  return {
    description: overrides.id,
    status: "running",
    startedAt: 0,
    lastActivityAt: 0,
    currentToolName: null,
    currentToolPreview: null,
    currentToolStartedAt: null,
    ...overrides,
  };
}

describe("pendingAskSnapshot", () => {
  test("repeated calls return complete identical snapshots for distinct sessions sharing a catalog", () => {
    const lanes = [
      lane({ id: "a1", agentId: "builder", description: "Build the thing" }),
      lane({ id: "a2", agentId: "builder" }),
    ];
    const peek = () => ({ question: "Which port?", questionId: "q1" });
    const expected = lanes.map((worker) => ({
      sessionId: worker.id,
      agentId: "builder",
      description: worker.description,
      question: "Which port?",
      questionId: "q1",
    }));
    expect(pendingAskSnapshot(lanes, peek)).toEqual(expected);
    expect(pendingAskSnapshot(lanes, peek)).toEqual(expected);
  });

  test("resolution, removal and replacement are reflected without prior watch state", () => {
    const lanes = [lane({ id: "a1" })];
    const asks = new Map([["a1", { question: "A?", questionId: "q1" }]]);
    const peek = (id: string) => asks.get(id);
    expect(pendingAskSnapshot(lanes, peek)[0]?.questionId).toBe("q1");
    expect(pendingAskSnapshot([], peek)).toEqual([]);
    asks.clear();
    expect(pendingAskSnapshot(lanes, peek)).toEqual([]);
    asks.set("a1", { question: "B?", questionId: "q2" });
    expect(pendingAskSnapshot(lanes, peek)[0]).toMatchObject({
      sessionId: "a1",
      question: "B?",
      questionId: "q2",
    });
  });

  test("only running root workers with a pending question are included", () => {
    const lanes = [
      lane({ id: "root" }),
      lane({ id: "child", parentSessionId: "orchestrator" }),
      lane({ id: "done", status: "done" }),
      lane({ id: "cancelled", status: "cancelled" }),
      lane({ id: "no-ask" }),
    ];
    const asks = pendingAskSnapshot(lanes, (id) =>
      id === "no-ask" ? undefined : { question: "Q?", questionId: "q1" },
    );
    expect(asks.map((ask) => ask.sessionId)).toEqual(["root"]);
  });
});

describe("pendingAskWakeText", () => {
  test("names agent, description, question and question id, and routes to send_input", () => {
    const text = pendingAskWakeText({
      sessionId: "a1",
      agentId: "builder",
      description: "Build the thing",
      question: "Which port?",
      questionId: "q1",
    });
    expect(text).toContain("builder");
    expect(text).toContain("Build the thing");
    expect(text).toContain("Which port?");
    expect(text).toContain("q1");
    expect(text).toContain("send_input");
    expect(text).toContain("using target a1");
    expect(text.toLowerCase()).toContain("worker");
  });
});
