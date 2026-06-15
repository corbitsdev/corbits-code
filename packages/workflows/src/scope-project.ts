import type { Workflow } from "./types.js";

// Turns a vague idea or existing ticket into a well-specified, actionable plan:
// requirement gathering, Q&A, planning, greybeard review, and ticket
// management. The front-end of build-feature; also useful standalone for
// planning without implementation.
export const scopeProject = {
  name: "scope-project",
  description: "Turn an idea or ticket into a reviewed, actionable plan",
  steps: [
    {
      id: "fetch-ticket",
      label: "Fetch ticket",
      capability: "ticket-tracker",
      optional: true,
      prompt:
        "If a ticket ID is in context, read the full description, comments, and " +
        "linked issues.",
    },
    {
      id: "read-context",
      label: "Read codebase context",
      prompt:
        "Identify the files and modules relevant to the scope and understand the " +
        "current state.",
    },
    {
      id: "qa",
      label: "Q&A",
      type: "gate",
      prompt:
        "Surface open questions to the user: ambiguous requirements, missing " +
        "constraints, scope boundaries, known risks. Wait for answers before " +
        "proceeding.",
    },
    {
      id: "write-plan",
      label: "Write plan",
      prompt:
        "Produce a structured implementation plan with discrete steps and call " +
        "submit_plan.",
    },
    {
      id: "greybeard-review",
      label: "Greybeard review",
      agent: "greybeard",
      optional: true,
      prompt:
        "Have greybeard review the plan for architectural issues, missing edge " +
        "cases, and scope creep. Catching scope issues in planning is free; catching " +
        "them in implementation is expensive.",
    },
    {
      id: "incorporate-feedback",
      label: "Incorporate feedback",
      prompt: "If greybeard flagged issues, revise the plan accordingly.",
    },
    {
      id: "update-ticket",
      label: "Update ticket",
      capability: "ticket-tracker",
      optional: true,
      prompt:
        "Post the final plan as a ticket comment. Break the ticket into sub-tasks if " +
        "the scope warrants it.",
    },
    {
      id: "gate",
      label: "Sign-off",
      type: "gate",
      prompt: "Surface the approved plan to the user for sign-off before execution begins.",
    },
  ],
} satisfies Workflow;
