import { tools } from "./toolset.js";
import { systemPrompt } from "./prompt.js";
import { config } from "./config.js";

export const director = {
  id: "coder",
  primaryIntent:
    "Implement the brief in product code — minimal safe diffs, root-cause fixes, tests with change",
  outOfLane: [
    "inventing speculative architecture or unnecessary abstractions",
    "expanding scope beyond the brief or chasing symptoms with workarounds",
    "pure exploration maps without code",
    "review-only verdicts",
    "orchestrating or spawning other agents",
  ],
  description:
    "Implementation specialist — minimal safe diffs, root-cause fixes, tests",
  systemPrompt: systemPrompt.build(),
  tools: { allow: [...tools] },
  spawn: config.spawn,
  tier: config.tier,
  modelRole: config.modelRole,
} as const;
