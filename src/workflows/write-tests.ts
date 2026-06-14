import type { Workflow } from "./types.js";

// Writes a complete, meaningful test suite for a piece of code. The mode — TDD
// (failing tests before implementation), coverage (passing tests for existing
// code), or bug (one failing reproduction) — is inferred from context. Used
// standalone or as the red-tests step inside build-feature.
export const writeTests = {
  name: "write-tests",
  description: "Write a meaningful test suite for a module or feature",
  steps: [
    {
      id: "baseline",
      label: "Run test suite baseline",
      prompt:
        "Run the current test suite and record the pass/fail count. Surface any " +
        "pre-existing failures before proceeding.",
    },
    {
      id: "identify-gaps",
      label: "Identify coverage gaps",
      prompt:
        "Read the target module(s) and a representative existing test file. List the " +
        "untested behaviors, edge cases, and error paths, and match the project's " +
        "test conventions.",
    },
    {
      id: "write",
      label: "Write tests",
      prompt:
        "Implement the tests one logical group at a time. Prefer behavior-based " +
        "tests over implementation-coupled ones. Never write a test that would pass " +
        "against any implementation.",
    },
    {
      id: "verify",
      label: "Verify red/green",
      prompt:
        "TDD mode: confirm new-behavior tests fail before implementation exists. " +
        "Coverage mode: confirm tests for existing code pass. Bug mode: confirm the " +
        "single reproduction test fails.",
    },
    {
      id: "commit",
      label: "Commit",
      prompt:
        "Commit the tests as a standalone commit: 'Add failing tests for <feature>' " +
        "(TDD), 'Add tests for <module>' (coverage), or 'Reproduce: <bug>' (bug).",
    },
    {
      id: "coverage-report",
      label: "Coverage report",
      prompt:
        "Summarize what was added, what remains uncovered, and any tests " +
        "intentionally skipped with rationale.",
    },
  ],
} satisfies Workflow;
