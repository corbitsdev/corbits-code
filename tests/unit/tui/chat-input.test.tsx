import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { useState } from "react";
import { ChatInput } from "../../../src/tui/components/chat-input.js";

const noopContext = { getModel: () => "m", setModel: () => {}, getVerbose: () => false, toggleVerbose: () => false };

test("ChatInput ignores keystrokes when inactive", async () => {
  let submitted: string | null = null;
  const { stdin } = render(
    <ChatInput
      onSubmit={(m) => { submitted = m; }}
      onCommand={() => {}}
      commandContext={noopContext}
      value="hello world"
      onChange={() => {}}
      active={false}
    />,
  );
  await Promise.resolve();
  stdin.write("\r");
  await Promise.resolve();
  expect(submitted).toBeNull();
});

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


test("cursor stays mid-string across successive edits", async () => {
  let current = "";
  function Harness() {
    const [v, setV] = useState("");
    current = v;
    return (
      <ChatInput
        onSubmit={() => {}}
        onCommand={() => {}}
        commandContext={noopContext}
        value={v}
        onChange={setV}
      />
    );
  }
  const { stdin } = render(<Harness />);
  const press = async (s: string) => { stdin.write(s); await Promise.resolve(); await Promise.resolve(); };

  await press("a");
  await press("b");
  await press("c");
  await press("[D");
  await press("[D");
  await press("X");
  await press("Y");
  expect(current).toBe("aXYbc");
});
