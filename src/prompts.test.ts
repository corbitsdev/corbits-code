import { expect, test } from "bun:test";

import { CHAT_PROMPT_QUALITY_MARKERS } from "./agent/prompt-contract.js";
import { buildChatSystemPrompt } from "./agent/prompts.js";

// Sole consumer of CHAT_PROMPT_QUALITY_MARKERS: deleting this test orphans the
// export (dead-export gate). The markers are the contract between the prompt
// builders and the reviewer checklist, so the pin stays meaningful.
test("chat system prompt satisfies system prompt quality markers", () => {
  const prompt = buildChatSystemPrompt();
  for (const marker of CHAT_PROMPT_QUALITY_MARKERS) {
    expect(prompt).toContain(marker);
  }
});
