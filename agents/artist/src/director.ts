import { tools } from "./toolset.js";
import { systemPrompt } from "./prompt.js";
import { config } from "./config.js";

/**
 * Artist worker director card. Structurally satisfies the app's
 * `DirectorPackage` (app-side drift-guard asserts assignability).
 * App-independent: imports `@intx/*` types only, no Corbits shared package.
 */
export const director = {
  id: "artist",
  primaryIntent:
    "Author hand-crafted SVGs, visual diagrams, and generative graphic prompts",
  outOfLane: [
    "backend or core product implementation",
    "code defect review or testing",
    "fleet orchestration or spawning",
  ],
  description:
    "Visual asset specialist — SVGs, visual diagrams, and generative graphic prompts",
  systemPrompt: systemPrompt.build(),
  tools: { allow: [...tools] },
  spawn: config.spawn,
  tier: config.tier,
  modelRole: config.modelRole,
} as const;
