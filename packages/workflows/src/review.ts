import type { Workflow } from "./types.js";

// Multi-agent review cycle. Always runs greybeard, CTO, and critic reviewers.
// Detects UI changes and adds draper/cmo reviewers automatically when relevant.
export const review = {
  name: "review",
  description: "Multi-agent review: greybeard, CTO, critic, and UI reviewers when applicable",
  autoAdvance: true,
  steps: [
    {
      id: "core-review",
      label: "Core review",
      agent: ["gaas:greybeard", "gaas:gaasbot", "gaas:critique"],
      parallel: true,
      prompt:
        "Review the changes in the current working tree (or the target specified by the user). " +
        "Each reviewer should independently assess correctness, architecture, and quality. " +
        "Report specific findings with file paths and line numbers.",
    },
    {
      id: "ui-review",
      label: "UI review",
      agent: ["cmo:draper", "cmo:emil"],
      parallel: true,
      optional: true,
      prompt:
        "If the changes include UI components, React files, CSS, or visual elements, run a " +
        "UI-focused review. Check design consistency, interaction quality, and brand alignment. " +
        "If no UI changes are present, skip this step by calling submit_output immediately.",
    },
    {
      id: "synthesize",
      label: "Synthesize findings",
      prompt:
        "Collect all findings from the review agents. Group them by severity (blocking, " +
        "suggestion, nitpick). List blocking issues that must be resolved before merge. " +
        "Present a concise summary the author can act on.",
    },
  ],
} satisfies Workflow;
