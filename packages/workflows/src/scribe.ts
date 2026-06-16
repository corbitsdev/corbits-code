import type { Workflow } from "./types.js";

// Documentation workflow. Audits existing docs, writes or updates them to
// match the current codebase, and commits the result.
export const scribe = {
  name: "scribe",
  description: "Write or update documentation for the given target",
  autoAdvance: true,
  steps: [
    {
      id: "audit",
      label: "Audit existing docs",
      prompt:
        "Read the existing documentation files (README, docs/, ARCHITECTURE.md, " +
        "IMPLEMENTATION.md, PRODUCT.md, AGENTS.md, CLAUDE.md, and any other relevant " +
        "markdown files) alongside the relevant source files. Identify what is out of date, " +
        "missing, or misleading. Do not edit anything yet.",
    },
    {
      id: "write",
      label: "Write documentation",
      skill: "gaas:scribe",
      prompt:
        "Following the scribe skill guidelines, write or update the documentation identified " +
        "in the audit phase. Match the style of existing docs. Focus on the target specified " +
        "in the user's request (or all docs if no specific target was given). Commit the " +
        "changes with a clear message.",
    },
    {
      id: "review",
      label: "Review docs",
      agent: "gaas:greybeard",
      prompt:
        "Review the documentation changes just committed. Check for accuracy, completeness, " +
        "clarity, and consistency with the codebase. Surface any issues found.",
    },
  ],
} satisfies Workflow;
