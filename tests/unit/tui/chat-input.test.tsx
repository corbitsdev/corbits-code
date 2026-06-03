import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { ChatInput } from "../../../src/tui/components/chat-input.js";

const noopContext = { getModel: () => "m", setModel: () => {} };

test("ChatInput renders prompt", () => {
  const { lastFrame } = render(
    <ChatInput
      onSubmit={() => {}}
      onCommand={() => {}}
      commandContext={noopContext}
      value=""
      onChange={() => {}}
    />,
  );
  expect(lastFrame()).toContain("> ");
});

test("ChatInput renders its controlled value", () => {
  const { lastFrame } = render(
    <ChatInput
      onSubmit={() => {}}
      onCommand={() => {}}
      commandContext={noopContext}
      value="hello"
      onChange={() => {}}
    />,
  );
  expect(lastFrame()).toContain("hello");
});
