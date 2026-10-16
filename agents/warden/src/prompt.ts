import { wardenCard } from "../../../packages/prompt-fragments/src/index.js";

export const theme = "warden";

// Composed card lives in @corbits/prompt-fragments. Byte-stable.
export const systemPrompt = {
  theme,
  build: (): string => wardenCard,
};
