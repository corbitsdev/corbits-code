import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { ChatInput } from "../../../src/tui/components/chat-input.js";

const noopContext = { getModel: () => "m", setModel: () => {}, getVerbose: () => false, toggleVerbose: () => false };

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

test("ChatInput does not exit the process on CTRL+C", async () => {
  const originalExit = process.exit;
  let exited = false;
  // @ts-expect-error narrowing the override for the test
  process.exit = (() => { exited = true; }) as typeof process.exit;
  try {
    const { stdin } = render(
      <ChatInput
        onSubmit={() => {}}
        onCommand={() => {}}
        commandContext={noopContext}
        value="hello"
        onChange={() => {}}
      />,
    );
    stdin.write("\x03");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(exited).toBe(false);
  } finally {
    process.exit = originalExit;
  }
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
