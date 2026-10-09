// Dispatch director card — the `DirectorPackage` data, extracted byte-for-byte
// from the in-tree `src/agent/directors/dispatch/package.ts` (now deleted).
// Structurally satisfies the app's `DirectorPackage` (asserted in-tree by
// `src/agent/directors/dispatch/package.test.ts`); it imports @intx/* only.

import { tools } from "./toolset.js";
import { systemPrompt } from "./prompt.js";
import { config } from "./config.js";

/** The assembled dispatch director card. */
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
