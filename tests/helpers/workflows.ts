import { beforeAll } from "bun:test";
import type { Workflow } from "../../src/workflows/definition.js";
import {
  clearWorkflowRegistryForTests,
  registerWorkflowPlugin,
} from "../../src/workflows/index.js";

// Sample workflows for runtime unit tests. The `Workflow` shape is plain data,
// so these live inline rather than depending on any bundled plugin. They
// exercise the paths the runtime tests assert on: an optional capability-gated
// step, a sub-workflow chain (build -> review), parallel agent steps, and a
// terminal gate.

const scope: Workflow = {
  name: "scope",
  description: "Scope a feature or task — creates a ticket or a local scope file",
  steps: [
    {
      id: "research",
      label: "Research context",
      prompt:
        "Explore the codebase and any referenced tickets to understand the scope. " +
        "Do not make changes yet.",
    },
    {
      id: "create-ticket",
      label: "Create ticket",
      capability: "ticket-tracker",
      optional: true,
      prompt: "Create a well-structured ticket from the research and return its URL.",
    },
    {
      id: "create-local-scope",
      label: "Write local scope file",
      prompt:
        "If a ticket was just created, skip. Otherwise write a local scope file with " +
        "goal, acceptance criteria, and an implementation checklist.",
    },
    {
      id: "suggest-build",
      label: "Suggest /build",
      type: "gate",
      prompt: "Summarize the scope and suggest running /build. Wait for confirmation.",
    },
  ],
};

const build: Workflow = {
  name: "build",
  description: "Full implementation workflow: implement, document, and review",
  steps: [
    {
      id: "fetch-ticket",
      label: "Fetch ticket",
      capability: "ticket-tracker",
      optional: true,
      prompt: "Fetch the referenced ticket, read its criteria, and mark it in progress.",
    },
    {
      id: "explore",
      label: "Explore codebase",
      prompt: "Read the files that will change. Do not edit yet.",
    },
    {
      id: "implement",
      label: "Implement",
      prompt: "Implement the change, update tests, run the suite, and commit.",
    },
    {
      id: "document",
      label: "Update docs",
      optional: true,
      prompt: "Update affected docs, or skip if nothing user-facing changed.",
    },
    { id: "review", label: "Review", workflow: "review" },
    {
      id: "update-ticket",
      label: "Update ticket",
      capability: "ticket-tracker",
      optional: true,
      prompt: "Post a status update with a summary and next steps on the ticket.",
    },
    {
      id: "gate",
      label: "Await approval",
      type: "gate",
      prompt: "Summarize the work and wait for approval before the workflow ends.",
    },
  ],
};

const review: Workflow = {
  name: "review",
  description: "Multi-agent review and synthesis",
  steps: [
    {
      id: "core-review",
      label: "Core review",
      agent: ["reviewer:architecture", "reviewer:quality"],
      parallel: true,
      prompt:
        "Review the changes for correctness, architecture, and quality. Report " +
        "specific findings with file paths and line numbers.",
    },
    {
      id: "ui-review",
      label: "UI review",
      agent: ["reviewer:ui"],
      parallel: true,
      optional: true,
      prompt: "If the changes include UI, run a UI-focused review. Otherwise skip.",
    },
    {
      id: "synthesize",
      label: "Synthesize findings",
      prompt:
        "Collect all findings, group by severity, and list blocking issues the " +
        "author must resolve.",
    },
  ],
};

export function installSampleWorkflowsForTests(): void {
  clearWorkflowRegistryForTests();
  registerWorkflowPlugin({ workflows: [scope, build, review] });
}

beforeAll(() => {
  installSampleWorkflowsForTests();
});
