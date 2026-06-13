import type { Workflow } from "./types.js";

// A thin, frequently reused workflow that keeps a ticket in sync with the
// current work state. Usually invoked as a step from other workflows. Every
// step requires the ticket-tracker capability, so the whole workflow is a no-op
// when no tracker is connected.
export const updateTicket = {
  name: "update-ticket",
  description: "Keep a ticket in sync with the current work state",
  steps: [
    {
      id: "identify-ticket",
      label: "Identify ticket",
      capability: "ticket-tracker",
      prompt:
        "Determine the ticket ID from context: the active workflow, the git branch " +
        "name (cl-NNNN-...), or the user. If none can be found, note it and stop — " +
        "all steps here are best-effort.",
    },
    {
      id: "summarize",
      label: "Summarize current state",
      capability: "ticket-tracker",
      prompt:
        "Produce a concise status update: what was done, what was decided, what " +
        "remains, and any blockers.",
    },
    {
      id: "post-comment",
      label: "Post comment",
      capability: "ticket-tracker",
      prompt: "Post the status update as a comment on the ticket.",
    },
    {
      id: "update-status",
      label: "Update status",
      capability: "ticket-tracker",
      prompt:
        "Move the ticket to the appropriate state for the context: In Progress " +
        "(work started), In Review (PR opened), or Done (merged). If the transition " +
        "is invalid, log and continue.",
    },
    {
      id: "update-priority",
      label: "Update priority",
      capability: "ticket-tracker",
      optional: true,
      prompt: "If triage surfaced a priority mismatch, update the ticket priority.",
    },
  ],
} satisfies Workflow;
