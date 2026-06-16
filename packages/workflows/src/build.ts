import type { Workflow } from "./types.js";

// Full implementation workflow: fetch context, implement, document, review,
// update the ticket, and gate on human approval. Each phase is a self-contained
// step that drives the agent forward without manual advancement.
export const build = {
  name: "build",
  description: "Full implementation workflow: implement, document, and review",
  autoAdvance: true,
  steps: [
    {
      id: "fetch-ticket",
      label: "Fetch ticket",
      capability: "ticket-tracker",
      optional: true,
      prompt:
        "Fetch the ticket referenced in the task (or find the most relevant open ticket). " +
        "Read its description and acceptance criteria carefully. Mark it In Progress.",
    },
    {
      id: "explore",
      label: "Explore codebase",
      prompt:
        "Read the files that will need to change. Understand the existing patterns, types, " +
        "and conventions. Do not make any changes yet. Identify the minimal set of edits needed.",
    },
    {
      id: "implement",
      label: "Implement",
      prompt:
        "Implement the feature or fix described in the task. Follow existing code style and " +
        "conventions. Write or update tests. Run the build and test suite. Commit changes " +
        "with a clear message once everything passes.",
    },
    {
      id: "document",
      label: "Update docs",
      workflow: "scribe",
      optional: true,
    },
    {
      id: "review",
      label: "Review",
      workflow: "review",
    },
    {
      id: "update-ticket",
      label: "Update ticket",
      capability: "ticket-tracker",
      optional: true,
      prompt:
        "Post a status update on the ticket: what was done, the PR link, and next steps. " +
        "Mark the ticket Done if the work is complete.",
    },
    {
      id: "gate",
      label: "Await approval",
      type: "gate",
      prompt:
        "Summarize what was implemented, list the commits and PR link, and surface any " +
        "review findings. Wait for the user to approve before the workflow ends.",
    },
  ],
} satisfies Workflow;
