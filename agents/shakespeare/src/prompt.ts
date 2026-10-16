import { shakespeareCard } from "../../../packages/prompt-fragments/src/index.js";

export const systemPrompt = {
  theme: "shakespeare",
  build: (): string => shakespeareCard,
};
