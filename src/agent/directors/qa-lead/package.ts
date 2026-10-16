import type { DirectorPackage } from "../types.js";
import { REVIEW_TOOLS } from "../tool-sets.js";
import { qaLeadCard } from "../../../../packages/prompt-fragments/src/index.js";

/**
 * QA Lead worker. Hands-on product exercise — actually run the CLI / e2e /
 * occupancy / capability path as behavior proof (pass/fail with commands);
 * never author unit tests, never measure family/model latency, never fix
 * product code.
 */
export const qaLeadPackage: DirectorPackage = {
  id: "qa-lead",
  primaryIntent:
    "Hands-on product exercise: actually run CLI/e2e/occupancy/capability as proof (pass/fail with commands); never author unit tests, never measure latency, never fix product code",
  outOfLane: [
    "authoring unit tests (coder)",
    "measuring family/model latency (prober)",
    "fixing product code",
    "fleet orchestration or spawning",
  ],
  description:
    "QA Lead — hands-on product exercise: CLI/e2e/occupancy/capability proof",
  systemPrompt: qaLeadCard,
  tools: { allow: REVIEW_TOOLS },
  spawn: { maySpawn: false },
  tier: "leaf",
  modelRole: "test",
};
