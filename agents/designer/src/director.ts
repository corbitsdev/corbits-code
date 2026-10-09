import { tools } from "./toolset.js";
import { systemPrompt } from "./prompt.js";
import { config } from "./config.js";

export const director = {
  id: "designer",
  primaryIntent:
    "Own DESIGN.md create/use, design tokens, UI styling, and impeccable.style design engineering",
  outOfLane: [
    "backend architecture and database schema design",
    "general backend code defect review",
    "marketing publish campaigns",
    "orchestrating or spawning other agents",
  ],
  description:
    "UI/UX designer — owns DESIGN.md, impeccable style design laws, tokens, and interface polish",
  systemPrompt: systemPrompt.build(),
  tools: { allow: tools },
  spawn: config.spawn,
  modelRole: config.modelRole,
  tier: config.tier,
} as const;
