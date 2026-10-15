import { describe, expect, test } from "bun:test";

import { programStatusForChrome } from "./program-status.js";

const doing = { title: "ship the mapper", status: "doing" as const };
const todo = { title: "later", status: "todo" as const };
const liveAgent = {
  agentId: "a",
  description: "read the tree",
  status: "running" as const,
  currentToolStartedAt: null,
};

describe("programStatusForChrome", () => {
  test("an open gate blocks even while work is in flight", () => {
    expect(
      programStatusForChrome({
        tasks: [doing],
        agents: [liveAgent],
        stalled: true,
        gateOpen: true,
      }),
    ).toEqual({
      state: "blocked",
      app: "corbits",
      title: "corbits",
      message: "waiting on the operator",
    });
  });

  test("a stalled turn is an error when no gate is open", () => {
    expect(
      programStatusForChrome({
        tasks: [doing],
        stalled: true,
        gateOpen: false,
      }).state,
    ).toBe("error");
  });

  test("a doing task names the working record", () => {
    expect(
      programStatusForChrome({
        tasks: [todo, doing],
        stalled: false,
        gateOpen: false,
      }),
    ).toMatchObject({ state: "working", message: "ship the mapper" });
  });

  test("a live agent is working when no task is doing", () => {
    expect(
      programStatusForChrome({
        agents: [liveAgent],
        stalled: false,
        gateOpen: false,
      }),
    ).toMatchObject({ state: "working", message: "read the tree" });
  });

  test("an idle session reports idle, not clear", () => {
    expect(
      programStatusForChrome({ stalled: false, gateOpen: false }),
    ).toMatchObject({ state: "idle", message: "idle" });
  });

  test("the report addresses the root record", () => {
    const status = programStatusForChrome({
      stalled: false,
      gateOpen: false,
    });
    expect("id" in status).toBe(false);
  });
});
