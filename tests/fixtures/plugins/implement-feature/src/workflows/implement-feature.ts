import type { Workflow } from "../../../../../../src/workflows/definition.js";

export const implementFeature: Workflow = {
  name: "implement-feature",
  description: "Plan, implement, test, and review a feature with parallel review agents",
  autoInvoke: "implement this feature",
  steps: [
    {
      id: "plan",
      label: "Plan",
      prompt:
        "Produce a concrete implementation plan: scope, files to touch, risks, and test strategy. Use ask_operator only if requirements are ambiguous.",
    },
    {
      id: "implement",
      label: "Implement",
      prompt: "Implement the plan. Match repo conventions and keep the diff focused.",
    },
    {
      id: "test",
      label: "Test",
      prompt:
        "Run the narrowest relevant checks, then broader tests as appropriate. Fix failures you introduced.",
    },
    {
      id: "review",
      label: "Parallel review",
      parallel: true,
      agent: ["review-correctness", "review-architecture", "review-tests"],
      prompt:
        "Review the implementation from your assigned lens. Report actionable findings only; say plainly if none.",
    },
    {
      id: "gate",
      label: "Ship approval",
      type: "gate",
      prompt:
        "Summarize the feature, test results, and review outcomes. Wait for operator approval.",
    },
  ],
};
