import { artistCard } from "../../../packages/prompt-fragments/src/index.js";

export const systemPrompt = {
  theme: "artist",
  build: (): string => artistCard,
};
