// Explorer director card; imports @intx/* only. The app asserts this satisfies
// `DirectorPackage` in-tree (src/agent/directors/explorer/package.test.ts).
import { tools } from "./toolset.js";
import { systemPrompt } from "./prompt.js";
import { config } from "./config.js";

export const director = {
  id: "explorer",
  primaryIntent: "Map and read the codebase; no product edits",
  outOfLane: [
    "product write paths",
    "drive-by fixes",
    "shipping features",
    "review severity theater",
  ],
  description: "Read-only exploration",
  systemPrompt: systemPrompt.build(),
  tools: { allow: tools },
  spawn: config.spawn,
  modelRole: config.modelRole,
  tier: config.tier,
} as const;
