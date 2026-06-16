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

test("ChatInput renders a multi-line value across lines with the caret on the last line", () => {
  const { lastFrame } = render(
    <ChatInput
      onSubmit={() => {}}
      onCommand={() => {}}
      commandContext={noopContext}
      value={"first\nsecond"}
      onChange={() => {}}
    />,
  );
  const frame = lastFrame() ?? "";
  expect(frame).toContain("> first");
  // The continuation line is present and the caret sits at the end of it.
  expect(frame).toMatch(/second\s*▏/);
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


test("Up/Down arrows move cursor between lines of a multi-line prompt", async () => {
  let current = "";
  let cursorPos = 0;
  function Harness() {
    const [v, setV] = useState("first\nsecond");
    current = v;
    return (
      <ChatInput
        onSubmit={() => {}}
        onCommand={() => {}}
        commandContext={noopContext}
        value={v}
        onChange={(val) => { setV(val); current = val; }}
        cwd="."
      />
    );
  }
  const { lastFrame, stdin } = render(<Harness />);
  await Promise.resolve();
  const initialFrame = lastFrame() ?? "";
  // Cursor starts at end of "second" (line 1)
  expect(initialFrame).toContain("second");

  // Up arrow should move cursor to "first" line — caret should appear there
  stdin.write("\x1B[A");
  await Promise.resolve();
  await Promise.resolve();
  const afterUp = lastFrame() ?? "";
  expect(afterUp).toContain("first");
  // The caret glyph should be on the first line now
  expect(afterUp).toMatch(/first.*▏/s);
});

test("ChatInput silently consumes SGR mouse scroll sequences", async () => {
  let current = "";
  const seq = "\x1B[<64;20;44M";  // scroll up event
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
  await Promise.resolve();
  // Send the SGR mouse sequence — it should be consumed, not added to the prompt
  stdin.write(seq);
  await Promise.resolve();
  await Promise.resolve();
  expect(current).toBe("");
  // Verify regular typing still works after the mouse event
  stdin.write("a");
  await Promise.resolve();
  await Promise.resolve();
  expect(current).toBe("a");
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
