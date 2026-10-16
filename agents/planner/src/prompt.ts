import { plannerCard } from "../../../packages/prompt-fragments/src/index.js";

export const systemPrompt = {
  theme: "planner",
  build: (): string => plannerCard,
};
