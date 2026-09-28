import { expect, test } from "bun:test";
import { tuiSendFailureMessage } from "./send-failure-message.js";

test("TUI send failures keep non-provider errors distinct", () => {
  expect(
    tuiSendFailureMessage(new Error("disk full"), "error", false, {
      providerId: "codex/work",
      displayLabel: "Codex",
    }),
  ).toBe("disk full");
});
