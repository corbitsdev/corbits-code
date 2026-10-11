import { describe, expect, test } from "bun:test";
import {
  assertCanTargetAgent,
  assertTierMayMountFleetVerb,
  FleetAuthorityError,
  isFleetVerb,
} from "./authority.js";

describe("assertTierMayMountFleetVerb", () => {
  test("a Tier 3 leaf cannot obtain a fleet verb", () => {
    expect(() => assertTierMayMountFleetVerb("leaf", "search_agents")).toThrow(
      FleetAuthorityError,
    );
    expect(() => assertTierMayMountFleetVerb("leaf", "spawn_agent")).toThrow(
      FleetAuthorityError,
    );
    // The reusable-session verbs are gated the same way.
    expect(() => assertTierMayMountFleetVerb("leaf", "close_agent")).toThrow(
      FleetAuthorityError,
    );
    expect(() => assertTierMayMountFleetVerb("leaf", "resume_agent")).toThrow(
      FleetAuthorityError,
    );
    // Interrupt_agent / send_input are gated the same way.
    expect(() =>
      assertTierMayMountFleetVerb("leaf", "interrupt_agent"),
    ).toThrow(FleetAuthorityError);
    expect(() => assertTierMayMountFleetVerb("leaf", "send_input")).toThrow(
      FleetAuthorityError,
    );
  });

  test("leaves may still mount non-fleet tools", () => {
    expect(() =>
      assertTierMayMountFleetVerb("leaf", "read_file"),
    ).not.toThrow();
  });

  test("Tier 1 and Tier 2 may mount spawn/control fleet verbs", () => {
    expect(() =>
      assertTierMayMountFleetVerb("orchestrator", "spawn_agent"),
    ).not.toThrow();
    expect(() =>
      assertTierMayMountFleetVerb("nested-orchestrator", "spawn_agent"),
    ).not.toThrow();
    expect(() =>
      assertTierMayMountFleetVerb("nested-orchestrator", "wait_agents"),
    ).not.toThrow();
  });

  // Fleet discovery is dispatch (Tier 1) only — nested directors keep
  // spawn allowlists but must not discover the full fleet.
  test("Tier 2 nested orchestrator cannot mount search_agents but may list its own fleet", () => {
    expect(() =>
      assertTierMayMountFleetVerb("nested-orchestrator", "search_agents"),
    ).toThrow(FleetAuthorityError);
    expect(() =>
      assertTierMayMountFleetVerb("nested-orchestrator", "list_agents"),
    ).not.toThrow();
  });

  test("Tier 1 orchestrator may mount search_agents and list_agents", () => {
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
  // Tree: dispatch(root) -> planner -> coder
  //                      -> explorer (sibling of planner)
  const nodes = [
    { id: "dispatch-session" },
    { id: "planner-session", parentSessionId: "dispatch-session" },
    { id: "coder-session", parentSessionId: "planner-session" },
    { id: "explorer-session", parentSessionId: "dispatch-session" },
  ];

  test("Tier 1 primary orchestrator can target anyone in the tree", () => {
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
    expect(() =>
      assertCanTargetAgent(dispatch, "explorer-session", nodes),
    ).not.toThrow();
  });

  test("Tier 2 nested orchestrator can target its own descendant", () => {
    const planner = {
      id: "planner-session",
      tier: "nested-orchestrator" as const,
    };
    expect(() =>
      assertCanTargetAgent(planner, "coder-session", nodes),
    ).not.toThrow();
  });

  test("Tier 2 nested orchestrator can target itself", () => {
    const planner = {
      id: "planner-session",
      tier: "nested-orchestrator" as const,
    };
    expect(() =>
      assertCanTargetAgent(planner, "planner-session", nodes),
    ).not.toThrow();
  });

  test("Tier 2 nested orchestrator cannot target a sibling", () => {
    const planner = {
      id: "planner-session",
      tier: "nested-orchestrator" as const,
    };
    expect(() =>
      assertCanTargetAgent(planner, "explorer-session", nodes),
    ).toThrow(FleetAuthorityError);
  });

  test("Tier 2 nested orchestrator cannot target an ancestor", () => {
    const planner = {
      id: "planner-session",
      tier: "nested-orchestrator" as const,
    };
    expect(() =>
      assertCanTargetAgent(planner, "dispatch-session", nodes),
    ).toThrow(FleetAuthorityError);
  });

  test("Tier 3 leaf cannot target any agent, even itself", () => {
    const intern = { id: "intern-session", tier: "leaf" as const };
    expect(() => assertCanTargetAgent(intern, "intern-session", nodes)).toThrow(
      FleetAuthorityError,
    );
  });
});
