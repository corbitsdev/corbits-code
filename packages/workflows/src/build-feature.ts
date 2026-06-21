import type { Workflow } from "./types.js";

// The flagship composite workflow. It chains the atomic workflows into the full
// end-to-end development recipe, with the creative implement step inline (it is
// the part that cannot be templated). Optional sub-workflow steps let the
// composite run even when an atomic is unavailable.
export const buildFeature = {
  name: "build-feature",
  description: "End-to-end feature implementation from ticket to reviewed PR",
  steps: [
    {
      id: "scope",
      label: "Scope the feature",
      workflow: "scope-project",
      capability: "ticket-tracker",
      optional: true,
    },
    {
      id: "tests",
      label: "Write failing tests",
      workflow: "write-tests",
    },
    {
      id: "implement",
      label: "Implement the feature",
      prompt:
        "Implement the feature so the failing tests pass. This is the creative work " +
        "that does not decompose further. Commit the implementation with a clear " +
        "message once the tests are green.",
    },
    {
      id: "review",
      label: "Review the change",
      workflow: "code-review",
    },
    {
      id: "document",
      label: "Update docs",
      workflow: "improve-docs",
      optional: true,
    },
    {
      id: "update-ticket",
      label: "Update the ticket",
      workflow: "update-ticket",
      capability: "ticket-tracker",
      optional: true,
    },
    {
      id: "human-approval",
      label: "Flag for human approval",
      type: "gate",
      prompt:
        "Summarize what was done, surface the PR link, and wait for human approval " +
        "before considering the workflow complete.",
    },
  ],
} satisfies Workflow;
