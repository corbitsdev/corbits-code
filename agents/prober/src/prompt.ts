import { proberCard } from "../../../packages/prompt-fragments/src/index.js";

export const systemPrompt = {
  theme: "prober",
  build: (): string => proberCard,
};
