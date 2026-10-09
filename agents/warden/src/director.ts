// Warden director card — the `DirectorPackage` data, extracted byte-for-byte
// from the in-tree `src/agent/directors/warden/package.ts` (now deleted).
// Structurally satisfies the app's `DirectorPackage` (asserted in-tree by
// `src/agent/directors/warden/package.test.ts`); it imports @intx/* only.

import { tools } from "./toolset.js";
import { systemPrompt } from "./prompt.js";
import { config } from "./config.js";

/** The assembled warden director card. */
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
