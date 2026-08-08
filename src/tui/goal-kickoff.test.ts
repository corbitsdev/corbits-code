import { describe, expect, test } from "bun:test";
import { goalKickoffUserMessage } from "../agent/goal.js";
import { createGoalKickoff, type GoalKickoffDeps } from "./goal-kickoff.js";

function harness(): { deps: GoalKickoffDeps; sent: string[] } {
  const sent: string[] = [];
  const deps: GoalKickoffDeps = {
    send: (text) => {
      sent.push(text);
      return Promise.resolve();
    },
    onSendFailure: () => {},
  };
  return { deps, sent };
}

describe("createGoalKickoff", () => {
  test("set phase delivers the kickoff message down the send path", async () => {
    const { deps, sent } = harness();
    const kickoff = createGoalKickoff(deps);

    kickoff("ship the feature", "set");
    // send() is fire-and-forget from kickoff's perspective; flush microtasks.
    await Promise.resolve();

    // This is the assertion the bug report calls out as missing: the message
    // must reach the send path, not merely mutate governor state.
    expect(sent).toEqual([goalKickoffUserMessage("ship the feature", "set")]);
    expect(sent[0]).toContain("manage_goal");
    expect(sent[0]).toContain("manage_tasks");
  });

  test("resume phase uses the same send path with phase: resume", async () => {
    const { deps, sent } = harness();
    const kickoff = createGoalKickoff(deps);

    kickoff("ship the feature", "resume");
    await Promise.resolve();

    expect(sent).toEqual([goalKickoffUserMessage("ship the feature", "resume")]);
    expect(sent[0]).toContain("Goal resumed.");
  });

  test("phase defaults to set", async () => {
    const { deps, sent } = harness();
    const kickoff = createGoalKickoff(deps);

    kickoff("ship the feature");
    await Promise.resolve();

    expect(sent).toEqual([goalKickoffUserMessage("ship the feature", "set")]);
  });

  test("send failures are routed to onSendFailure, not thrown", async () => {
    let failure: unknown;
    const deps: GoalKickoffDeps = {
      send: () => Promise.reject(new Error("boom")),
      onSendFailure: (err) => {
        failure = err;
      },
    };
    const kickoff = createGoalKickoff(deps);

    kickoff("ship the feature", "set");
    await Promise.resolve();
    await Promise.resolve();

    expect(failure).toBeInstanceOf(Error);
  });
});
