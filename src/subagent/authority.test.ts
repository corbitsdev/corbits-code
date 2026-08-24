import { describe, expect, test } from "bun:test";
import {
  assertCanTargetAgent,
  assertTierMayMountFleetVerb,
  FleetAuthorityError,
  isFleetVerb,
} from "./authority.js";

describe("assertTierMayMountFleetVerb", () => {
  test("a Tier 3 leaf cannot obtain a fleet verb", () => {
    expect(() => assertTierMayMountFleetVerb("leaf", "task")).toThrow(FleetAuthorityError);
    expect(() => assertTierMayMountFleetVerb("leaf", "search_agents")).toThrow(FleetAuthorityError);
    expect(() => assertTierMayMountFleetVerb("leaf", "spawn_agent")).toThrow(FleetAuthorityError);
  });

  test("leaves may still mount non-fleet tools", () => {
    expect(() => assertTierMayMountFleetVerb("leaf", "read_file")).not.toThrow();
  });

  test("Tier 1 and Tier 2 may mount fleet verbs", () => {
    expect(() => assertTierMayMountFleetVerb("orchestrator", "task")).not.toThrow();
    expect(() => assertTierMayMountFleetVerb("nested-orchestrator", "task")).not.toThrow();
  });

  test("isFleetVerb matches the same set used for the gate", () => {
    expect(isFleetVerb("task")).toBe(true);
    expect(isFleetVerb("write_file")).toBe(false);
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
