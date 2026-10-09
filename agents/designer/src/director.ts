// Designer director card — the `DirectorPackage` data, extracted byte-for-byte
// from the in-tree `src/agent/directors/designer/package.ts` (now deleted).
// Structurally satisfies the app's `DirectorPackage` (asserted in-tree by
// `src/agent/directors/designer/package.test.ts`); it imports @intx/* only.

import { tools } from "./toolset.js";
import { systemPrompt } from "./prompt.js";
import { config } from "./config.js";

/** The assembled designer director card. */
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
