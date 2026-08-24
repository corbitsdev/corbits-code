import { describe, expect, test } from "bun:test";
import {
  assertCanTargetAgent,
  assertTierMayMountFleetVerb,
  FleetAuthorityError,
  isDiscoveryVerb,
  isFleetVerb,
  shouldMountSearchAgents,
} from "./authority.js";

describe("assertTierMayMountFleetVerb", () => {
  test("a Tier 3 leaf cannot obtain a fleet verb", () => {
    expect(() => assertTierMayMountFleetVerb("leaf", "task")).toThrow(FleetAuthorityError);
    expect(() => assertTierMayMountFleetVerb("leaf", "search_agents")).toThrow(FleetAuthorityError);
    expect(() => assertTierMayMountFleetVerb("leaf", "spawn_agent")).toThrow(FleetAuthorityError);
    // The reusable-session verbs are gated the same way.
    expect(() => assertTierMayMountFleetVerb("leaf", "close_agent")).toThrow(FleetAuthorityError);
    expect(() => assertTierMayMountFleetVerb("leaf", "resume_agent")).toThrow(FleetAuthorityError);
    // Interrupt_agent / followup_task are gated the same way.
    expect(() => assertTierMayMountFleetVerb("leaf", "interrupt_agent")).toThrow(
      FleetAuthorityError,
    );
    expect(() => assertTierMayMountFleetVerb("leaf", "followup_task")).toThrow(FleetAuthorityError);
  });

  test("leaves may still mount non-fleet tools", () => {
    expect(() => assertTierMayMountFleetVerb("leaf", "read_file")).not.toThrow();
  });

  test("Tier 1 and Tier 2 may mount non-discovery fleet verbs", () => {
    expect(() => assertTierMayMountFleetVerb("orchestrator", "task")).not.toThrow();
    expect(() => assertTierMayMountFleetVerb("nested-orchestrator", "task")).not.toThrow();
  });

  test("discovery verbs are Tier 1 only (CL-7051)", () => {
    expect(() => assertTierMayMountFleetVerb("orchestrator", "search_agents")).not.toThrow();
    expect(() => assertTierMayMountFleetVerb("orchestrator", "list_agents")).not.toThrow();
    expect(() => assertTierMayMountFleetVerb("nested-orchestrator", "search_agents")).toThrow(
      FleetAuthorityError,
    );
    expect(() => assertTierMayMountFleetVerb("nested-orchestrator", "list_agents")).toThrow(
      FleetAuthorityError,
    );
    expect(() => assertTierMayMountFleetVerb("leaf", "search_agents")).toThrow(FleetAuthorityError);
    expect(() => assertTierMayMountFleetVerb("leaf", "list_agents")).toThrow(FleetAuthorityError);
  });

  test("isFleetVerb / isDiscoveryVerb match the same sets used for the gate", () => {
    expect(isFleetVerb("task")).toBe(true);
    expect(isFleetVerb("write_file")).toBe(false);
    expect(isDiscoveryVerb("search_agents")).toBe(true);
    expect(isDiscoveryVerb("list_agents")).toBe(true);
    expect(isDiscoveryVerb("task")).toBe(false);
  });
});

describe("shouldMountSearchAgents", () => {
  test("mounts only for Tier 1 when profiles are available", () => {
    expect(shouldMountSearchAgents("orchestrator", true)).toBe(true);
    expect(shouldMountSearchAgents("orchestrator", false)).toBe(false);
    expect(shouldMountSearchAgents("nested-orchestrator", true)).toBe(false);
    expect(shouldMountSearchAgents("leaf", true)).toBe(false);
  });
});

describe("assertCanTargetAgent", () => {
  // Tree: skywalker(root) -> greybeard -> intern
  //                       -> build (sibling of greybeard)
  const nodes = [
    { id: "skywalker-session" },
    { id: "greybeard-session", parentSessionId: "skywalker-session" },
    { id: "intern-session", parentSessionId: "greybeard-session" },
    { id: "build-session", parentSessionId: "skywalker-session" },
  ];

  test("Tier 1 primary orchestrator can target anyone in the tree", () => {
    const skywalker = { id: "skywalker-session", tier: "orchestrator" as const };
    expect(() => assertCanTargetAgent(skywalker, "greybeard-session", nodes)).not.toThrow();
    expect(() => assertCanTargetAgent(skywalker, "intern-session", nodes)).not.toThrow();
    expect(() => assertCanTargetAgent(skywalker, "build-session", nodes)).not.toThrow();
  });

  test("Tier 2 nested orchestrator can target its own descendant", () => {
    const greybeard = { id: "greybeard-session", tier: "nested-orchestrator" as const };
    expect(() => assertCanTargetAgent(greybeard, "intern-session", nodes)).not.toThrow();
  });

  test("Tier 2 nested orchestrator can target itself", () => {
    const greybeard = { id: "greybeard-session", tier: "nested-orchestrator" as const };
    expect(() => assertCanTargetAgent(greybeard, "greybeard-session", nodes)).not.toThrow();
  });

  test("Tier 2 nested orchestrator cannot target a sibling", () => {
    const greybeard = { id: "greybeard-session", tier: "nested-orchestrator" as const };
    expect(() => assertCanTargetAgent(greybeard, "build-session", nodes)).toThrow(
      FleetAuthorityError,
    );
  });

  test("Tier 2 nested orchestrator cannot target an ancestor", () => {
    const greybeard = { id: "greybeard-session", tier: "nested-orchestrator" as const };
    expect(() => assertCanTargetAgent(greybeard, "skywalker-session", nodes)).toThrow(
      FleetAuthorityError,
    );
  });

  test("Tier 3 leaf cannot target any agent, even itself", () => {
    const intern = { id: "intern-session", tier: "leaf" as const };
    expect(() => assertCanTargetAgent(intern, "intern-session", nodes)).toThrow(
      FleetAuthorityError,
    );
  });
});
