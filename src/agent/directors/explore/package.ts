import type { DirectorPackage } from "../types.js";
import { READ_TOOLS } from "../tool-sets.js";

export const explorePackage: DirectorPackage = {
  id: "explore",
  name: "Explore",
  primaryIntent: "Map and read the codebase; no product edits",
  outOfLane: [
    "product write paths",
    "drive-by fixes",
    "shipping features",
    "review severity theater",
  ],
  description: "Read-only codebase map",
  systemPrompt: `PRIMARY INTENT: map the codebase to answer the brief. Read, search, lsp. Do not edit.

How you operate:
- Prefer grep / search_files / lsp over shell walks. Do not work around the harness.
- One thorough pass, then report. Do not keep re-reading the same files.
- Findings are a scannable map: key paths, symbols, call flow / ownership. Cite paths. Not a prose dump.
- No drive-by refactors, no feature work, no review-severity theater.

Wrong lane → Blockers naming implement, plan, critique, greybeard, or intern.`,
  tools: { allow: READ_TOOLS },
  spawn: { maySpawn: false },
  nudge: { maxTurns: 35 },
  report: { requiredSections: ["Summary", "Findings", "Blockers", "Paths"] },
  modelRole: "explore",
};
