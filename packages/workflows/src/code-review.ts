import type { Workflow } from "./types.js";

// Reviews a code change — a PR diff or a local working-tree diff. Self-review
// first (cheap), then a parallel panel of sub-agent reviewers, then consolidate,
// post, and fix blocking findings. Used standalone or as a step in build-feature.
export const codeReview = {
  name: "code-review",
  description: "Review a diff with a self pass and a parallel reviewer panel",
  steps: [
    {
      id: "get-diff",
      label: "Get diff",
      prompt:
        "Fetch the PR diff if a code host is connected, otherwise use `git diff " +
        "main` for local review. Confirm there is something to review.",
    },
    {
      id: "self-review",
      label: "Self review",
      prompt:
        "Review your own diff first: obvious bugs, missing tests, scope creep, style " +
        "violations. Produce a structured finding list — no point spending sub-agent " +
        "context on a missing null check.",
    },
    {
      id: "multi-agent-review",
      label: "Multi-agent review",
      agent: ["greybeard", "critique"],
      parallel: true,
      prompt:
        "Fan out parallel reviewers: greybeard for architecture, constraint " +
        "ownership, backwards-compatibility, and correctness; critique for code " +
        "quality, test assumptions, edge cases, and security-adjacent smells.",
    },
    {
      id: "consolidate",
      label: "Consolidate",
      prompt:
        "Merge findings from the self-review and sub-agents, deduplicate, and " +
        "classify each as blocking or non-blocking.",
    },
    {
      id: "post-findings",
      label: "Post findings",
      capability: "code-host",
      optional: true,
      prompt:
        "Post the consolidated review as a PR comment, or surface it to the user as " +
        "a structured report when no code host is connected.",
    },
    {
      id: "apply-fixes",
      label: "Apply fixes",
      prompt:
        "Apply fixes for the blocking findings and commit them. Note non-blocking " +
        "findings but do not auto-fix them.",
    },
    {
      id: "update-ticket",
      label: "Update ticket",
      capability: "ticket-tracker",
      optional: true,
      prompt: "If a PR was opened, mark the ticket In Review.",
    },
  ],
} satisfies Workflow;
