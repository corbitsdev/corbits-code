import type { Workflow } from "./types.js";

// Scopes a feature, task, or initiative. Creates a Linear issue/project when
// the ticket-tracker capability is available; falls back to a local scope file
// at .intercode/scope/<slug>.md. On completion the agent suggests /build.
export const scope = {
  name: "scope",
  description: "Scope a feature or task — creates a Linear issue/project or a local scope file",
  autoAdvance: true,
  steps: [
    {
      id: "research",
      label: "Research context",
      prompt:
        "Explore the codebase and any referenced tickets to understand the full scope of the " +
        "request. Read relevant source files, existing architecture docs, and any open issues. " +
        "Do not make any changes yet — this is a read-only research phase.",
    },
    {
      id: "create-ticket",
      label: "Create Linear issue/project",
      capability: "ticket-tracker",
      optional: true,
      skill: "gaas:linear-create",
      prompt:
        "Using the research from the previous step, create a well-structured Linear issue or " +
        "project following the linear-create skill guidelines. Include background, outcome " +
        "checkboxes, and acceptance criteria. Return the Linear URL in your output.",
    },
    {
      id: "create-local-scope",
      label: "Write local scope file",
      prompt:
        "If a Linear ticket was just created, skip this step by calling submit_output immediately. " +
        "Otherwise write a local scope file at .intercode/scope/<slug>.md with: background, " +
        "goal, acceptance criteria, and a step-by-step implementation checklist.",
    },
    {
      id: "suggest-build",
      label: "Suggest /build",
      type: "gate",
      prompt:
        "Summarize the scope just created (with Linear URL if available) and suggest the user " +
        "run /build to begin implementation. Wait for their confirmation before the workflow ends.",
    },
  ],
} satisfies Workflow;
