import type { Workflow } from "./types.js";

// Keeps documentation in sync with code changes. Docs-only — it never touches
// source. The scribe skill does the actual writing; this workflow handles
// discovery and coordination. Used standalone or at the end of build-feature.
export const improveDocs = {
  name: "improve-docs",
  description: "Bring documentation back in sync with code changes",
  steps: [
    {
      id: "identify-docs",
      label: "Identify affected docs",
      prompt:
        "Given the current diff or a description of what changed, find every " +
        "document that references the changed behavior: README, PLAN.md, AGENTS.md, " +
        "inline comments, skill files, and docs/. List them.",
    },
    {
      id: "gap-analysis",
      label: "Gap analysis",
      prompt:
        "For each affected doc, determine what is now outdated, missing, or " +
        "incorrect.",
    },
    {
      id: "update-docs",
      label: "Update docs",
      skill: "scribe",
      prompt:
        "Update each affected document in turn. The scribe skill handles the " +
        "formatting conventions and document structure.",
    },
    {
      id: "review",
      label: "Review updates",
      prompt:
        "Read back the updated sections and confirm they accurately describe the " +
        "current behavior — no hallucinated details, no leftover stale content.",
    },
    {
      id: "commit",
      label: "Commit",
      prompt: "Commit the doc changes as a standalone commit: Update docs for <change>.",
    },
  ],
} satisfies Workflow;
