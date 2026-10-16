import { reviewerCard } from "../../../packages/prompt-fragments/src/index.js";

// Composed card lives in @corbits/prompt-fragments. Byte-stable.
export const systemPrompt = {
  theme: "reviewer",
  build: (): string => reviewerCard,
};
