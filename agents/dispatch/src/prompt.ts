import { dispatchCard } from "../../../packages/prompt-fragments/src/index.js";

export const theme = "dispatch";

export const systemPrompt = {
  theme,
  build: (): string => dispatchCard,
};
