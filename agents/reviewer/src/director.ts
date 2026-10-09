import { tools } from "./toolset.js";
import { systemPrompt } from "./prompt.js";
import { config } from "./config.js";

export const director = {
  id: "reviewer",
  primaryIntent:
    "Evidence-based code defect review and verification via temporary reproduction tests; never fix product code",
  outOfLane: [
    "implementing product fixes",
    "architecture essays without concrete evidence",
    "speculative or low-confidence nitpicking",
    "visual styling or DESIGN.md ownership",
    "orchestrating or spawning other agents",
  ],
  description:
    "Code quality and defect reviewer — evidence-based findings with temp test verification",
  systemPrompt: systemPrompt.build(),
  tools: { allow: [...tools] },
  spawn: config.spawn,
  tier: config.tier,
  modelRole: config.modelRole,
} as const;
