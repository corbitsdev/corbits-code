import { tools } from "./toolset.js";
import { systemPrompt } from "./prompt.js";
import { config } from "./config.js";

export const director = {
  id: "warden",
  primaryIntent:
    "Trust review of permission, provider-auth, and plugin-loader diffs; never fix product code",
  outOfLane: [
    "implementing fixes",
    "general code review outside trust paths",
    "architecture judgment without trust evidence",
    "feature design",
  ],
  description: "Permission and trust review worker",
  systemPrompt: systemPrompt.build(),
  tools: { allow: tools },
  spawn: config.spawn,
  modelRole: config.modelRole,
  tier: config.tier,
} as const;
