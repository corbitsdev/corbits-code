import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { ChatInput } from "../../../src/tui/components/chat-input.js";

test("ChatInput renders prompt", () => {
  const { lastFrame } = render(<ChatInput onSubmit={() => {}} />);
  expect(lastFrame()).toContain("> ");
});
