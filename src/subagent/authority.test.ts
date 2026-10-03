import { describe, expect, test } from "bun:test";
import {
  assertCanTargetAgent,
  assertTierMayMountFleetVerb,
  FleetAuthorityError,
  isFleetVerb,
} from "./authority.js";

describe("assertTierMayMountFleetVerb", () => {
  test("a worker cannot obtain a fleet verb", () => {
    expect(() =>
      assertTierMayMountFleetVerb("worker", "search_agents"),
    ).toThrow(FleetAuthorityError);
    expect(() => assertTierMayMountFleetVerb("worker", "spawn_agent")).toThrow(
      FleetAuthorityError,
    );
    expect(() => assertTierMayMountFleetVerb("worker", "close_agent")).toThrow(
      FleetAuthorityError,
    );
    expect(() => assertTierMayMountFleetVerb("worker", "resume_agent")).toThrow(
      FleetAuthorityError,
    );
    expect(() =>
      assertTierMayMountFleetVerb("worker", "interrupt_agent"),
    ).toThrow(FleetAuthorityError);
    expect(() => assertTierMayMountFleetVerb("worker", "send_input")).toThrow(
      FleetAuthorityError,
    );
    expect(() => assertTierMayMountFleetVerb("worker", "list_agents")).toThrow(
      FleetAuthorityError,
    );
  });

  test("workers may still mount non-fleet tools", () => {
    expect(() =>
      assertTierMayMountFleetVerb("worker", "read_file"),
    ).not.toThrow();
  });

  test("only dispatch may mount fleet verbs", () => {
    expect(() =>
      assertTierMayMountFleetVerb("orchestrator", "spawn_agent"),
    ).not.toThrow();
    expect(() =>
      assertTierMayMountFleetVerb("orchestrator", "search_agents"),
    ).not.toThrow();
    expect(() =>
      assertTierMayMountFleetVerb("orchestrator", "list_agents"),
    ).not.toThrow();
  });

  test("isFleetVerb matches the same set used for the gate", () => {
    expect(isFleetVerb("spawn_agent")).toBe(true);
    expect(isFleetVerb("task")).toBe(false);
    expect(isFleetVerb("write_file")).toBe(false);
  });
});

describe("assertCanTargetAgent", () => {
  const nodes = [
    { id: "dispatch-session" },
    { id: "planner-session", parentSessionId: "dispatch-session" },
    { id: "coder-session", parentSessionId: "dispatch-session" },
  ];

  test("dispatch can target anyone in the tree", () => {
    const dispatch = {
      id: "dispatch-session",
      tier: "orchestrator" as const,
    };
    expect(() =>
      assertCanTargetAgent(dispatch, "planner-session", nodes),
    ).not.toThrow();
    expect(() =>
      assertCanTargetAgent(dispatch, "coder-session", nodes),
    ).not.toThrow();
  });

  test("a worker cannot target any agent, even itself", () => {
    const intern = { id: "intern-session", tier: "worker" as const };
    expect(() => assertCanTargetAgent(intern, "intern-session", nodes)).toThrow(
      FleetAuthorityError,
    );
    expect(() => assertCanTargetAgent(intern, "coder-session", nodes)).toThrow(
      FleetAuthorityError,
    );
  });
});
