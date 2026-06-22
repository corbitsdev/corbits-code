import { expect, test } from "bun:test";

import { workflowKickoffUserMessage } from "../../src/workflows/kickoff.js";

test("workflowKickoffUserMessage forwards trimmed operator args", () => {
  expect(workflowKickoffUserMessage("  the README  ")).toBe("the README");
});

test("workflowKickoffUserMessage uses a neutral prompt when args are empty", () => {
  expect(workflowKickoffUserMessage("")).toBe("Continue.");
  expect(workflowKickoffUserMessage("   ")).toBe("Continue.");
});