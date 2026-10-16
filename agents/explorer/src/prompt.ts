import { explorerCard } from "../../../packages/prompt-fragments/src/index.js";

export const theme = "explorer";

export const systemPrompt = {
  theme,
  build: (): string => explorerCard,
};
