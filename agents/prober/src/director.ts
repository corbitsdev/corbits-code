import { tools } from "./toolset.js";
import { systemPrompt } from "./prompt.js";
import { config } from "./config.js";

export const director = {
  id: "prober",
  primaryIntent:
    "Measure latency and behavior distributions per family/model; never ship product code, never tune prompts or policy",
  outOfLane: [
    "shipping product code",
    "tuning prompts or model-family policy",
    "building a new eval harness",
    "fleet orchestration",
    "architecture essays without measurements",
  ],
  description: "Measure-only latency/behavior prober per family/model",
  systemPrompt: systemPrompt.build(),
  tools: { allow: [...tools] },
  spawn: config.spawn,
  tier: config.tier,
  modelRole: config.modelRole,
} as const;
