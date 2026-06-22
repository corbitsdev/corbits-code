import { describe, expect, test } from "bun:test";

import type { AgentProfile } from "../agent/profiles.js";
import { removeAgentProfile, upsertAgentProfile } from "./agent-profiles.js";

const base: AgentProfile[] = [
  { id: "greybeard", tier: "clever" },
  { id: "critique", tier: "standard" },
];

describe("agent profile list helpers", () => {
  test("upsertAgentProfile replaces by id and keeps a stable sort", () => {
    expect(upsertAgentProfile(base, { id: "greybeard", tier: "fast" })).toEqual([
      { id: "critique", tier: "standard" },
      { id: "greybeard", tier: "fast" },
    ]);
  });

  test("removeAgentProfile removes only the requested id", () => {
    expect(removeAgentProfile(base, "critique")).toEqual([{ id: "greybeard", tier: "clever" }]);
  });
});
