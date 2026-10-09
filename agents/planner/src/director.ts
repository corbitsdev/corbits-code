import { tools } from "./toolset.js";
import { systemPrompt } from "./prompt.js";
import { config } from "./config.js";

export const director = {
  id: "planner",
  primaryIntent:
    "Author requirements (PRD.md), solution scopes (SOLUTION_SCOPE.md), and ordered build plans (BUILD_PLAN.md)",
  outOfLane: [
    "shipping product implementation code",
    "fleet orchestration or spawning",
    "pure code defect review",
    "becoming Coder or Reviewer as primary",
  ],
  description:
    "Planning specialist — PRD.md, SOLUTION_SCOPE.md, and BUILD_PLAN.md authoring",
  systemPrompt: systemPrompt.build(),
  tools: { allow: [...tools] },
  spawn: config.spawn,
  tier: config.tier,
  modelRole: config.modelRole,
} as const;
