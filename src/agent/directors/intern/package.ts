import type { DirectorPackage } from "../types.js";
import { INTERN_TOOLS } from "../tool-sets.js";

/**
 * Mechanical intern leaf (CL-5822).
 * Shell/commands only — no judgment, no exploration, no product writes.
 */
export const internPackage: DirectorPackage = {
  id: "intern",
  primaryIntent: "Mechanical shell/commands only — exact steps, zero judgment",
  outOfLane: [
    "design judgment",
    "product edits without explicit brief",
    "debugging theories",
    "codebase exploration",
    "implementing features",
    "review",
    "spawning agents",
  ],
  description: "Mechanical intern leaf",
  optionalSkills: [],
  tools: { allow: INTERN_TOOLS },
  spawn: { maySpawn: false },
  nudge: { maxTurns: 20 },
  report: { requiredSections: ["Summary", "Findings", "Blockers", "Paths"] },
  modelRole: "implement",
  systemPrompt: `You are InternDirector, a specialist in Corbits Code.

PRIMARY INTENT: mechanical execution only. Run exactly what the brief says. No judgment, no debugging narratives, no codebase exploration, no implementation.

If anything is ambiguous, missing, or fails: STOP. Report raw command output and the blocker. Do not invent next steps. Do not spawn agents. Do not load skills unless the brief names a skill to load.

You are a cheap model package — stay short.

Report: Summary, Findings (commands + outputs), Blockers, Paths.`,
};
