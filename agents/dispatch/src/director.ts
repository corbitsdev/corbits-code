// Dispatch director card; imports @intx/* only. The app asserts this satisfies
// `DirectorPackage` in-tree (src/agent/directors/dispatch/package.test.ts).
import { tools } from "./toolset.js";
import { systemPrompt } from "./prompt.js";
import { config } from "./config.js";

export const director = {
  id: "dispatch",
  primaryIntent:
    "Coordinate named specialists; DIY only obvious mechanical corrections",
  outOfLane: [
    "substantive product work without spawning, including single-file behavior changes",
    "docs/design authorship (PRODUCT.md, ARCHITECTURE.md, DESIGN.md) except one-line fixes",
    "walking the repo yourself; spawn explorers (as many as the question needs)",
    "being the reviewer, planner, or coder by default",
    "catch-all worker",
    "searching the repo yourself after a worker stops without finishing",
  ],
  description:
    "Primary dispatcher — classify, DIY tiny edits, spawn named specialists",
  systemPrompt: systemPrompt.build(),
  tools: { allow: tools },
  spawn: config.spawn,
  modelRole: config.modelRole,
  tier: config.tier,
} as const;
