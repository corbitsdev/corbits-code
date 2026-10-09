import { tools } from "./toolset.js";
import { systemPrompt } from "./prompt.js";
import { config } from "./config.js";

/**
 * Shakespeare worker director card (CL-7029). Structurally satisfies the app's
 * `DirectorPackage` (app-side drift-guard asserts assignability). App-independent.
 */
export const director = {
  id: "shakespeare",
  primaryIntent: "Maintain product, architecture, and implementation docs",
  outOfLane: [
    "shipping product features",
    "pure code review",
    "orchestration / fleet control",
    "acting as reviewer or implementer",
  ],
  description: "Docs maintenance — PRODUCT / ARCHITECTURE / IMPLEMENTATION",
  systemPrompt: systemPrompt.build(),
  tools: { allow: [...tools] },
  spawn: config.spawn,
  tier: config.tier,
  modelRole: config.modelRole,
} as const;
