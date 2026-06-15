import type { Workflow } from "./types.js";

// Handles a bug report end-to-end up to (but not including) the fix: reproduce,
// classify, write a failing test that proves it, and optionally update the
// ticket. Stopping before the fix keeps triage atomic — the failing-test commit
// is the deliverable, useful whether the fix happens now or later.
export const triageBug = {
  name: "triage-bug",
  description: "Reproduce, classify, and prove a bug with a failing test",
  steps: [
    {
      id: "fetch-context",
      label: "Fetch bug context",
      capability: "ticket-tracker",
      optional: true,
      prompt:
        "If a ticket ID is provided, fetch the issue description, steps to " +
        "reproduce, and comments.",
    },
    {
      id: "reproduce",
      label: "Reproduce",
      prompt:
        "Read the relevant code paths and reproduce the failure locally via " +
        "run_shell or a test run. Confirm the bug is real and understand the root " +
        "cause.",
    },
    {
      id: "classify",
      label: "Classify",
      prompt:
        "Determine severity (P0 wedges/corrupts, P1 visibly broken, P2 degraded, " +
        "P3 cosmetic) and identify which layer owns the violated invariant (per the " +
        "philosophy skill's constraint-ownership rule).",
    },
    {
      id: "write-failing-test",
      label: "Write failing test",
      prompt:
        "Write a test that reproduces the bug and currently fails. Commit it as a " +
        "standalone commit: 'Reproduce: <description>'.",
    },
    {
      id: "update-ticket",
      label: "Update ticket",
      capability: "ticket-tracker",
      optional: true,
      prompt:
        "Post the findings (confirmed reproduction, root cause, severity, owning " +
        "layer) as a ticket comment. Update priority if classification differs.",
    },
    {
      id: "gate",
      label: "Hand off",
      type: "gate",
      prompt:
        "Surface the findings and the failing-test commit to the user and ask " +
        "whether to proceed with fixing or hand off. Triage deliberately stops " +
        "before the fix.",
    },
  ],
} satisfies Workflow;
