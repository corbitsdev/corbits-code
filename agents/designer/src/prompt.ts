import { designerCard } from "../../../packages/prompt-fragments/src/index.js";

export const theme = "designer";

export const systemPrompt = {
  theme,
  build: (): string => designerCard,
};
