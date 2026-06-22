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

test("ChatInput only shows steer and queue hint while processing with prompt text", () => {
  const empty = render(
    <ChatInput
      onSubmit={() => {}}
      onCommand={() => {}}
      commandContext={noopContext}
      value=""
      onChange={() => {}}
      isProcessing={true}
      queuedCount={1}
    />,
  );
  expect(empty.lastFrame()).not.toContain("queued");
  expect(empty.lastFrame()).not.toContain("steer");

  const filled = render(
    <ChatInput
      onSubmit={() => {}}
      onCommand={() => {}}
      commandContext={noopContext}
      value="follow up"
      onChange={() => {}}
      isProcessing={true}
      queuedCount={2}
    />,
  );
  const frame = filled.lastFrame() ?? "";
  expect(frame).toContain("2 queued · Enter steer · Alt+Enter queue");
  expect(frame.indexOf("2 queued")).toBeLessThan(frame.indexOf("> follow up"));
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

test("Alt+Enter while processing queues without inserting escape bytes", async () => {
  let current = "follow up";
  let submitted: string | null = null;
  function Harness() {
    const [v, setV] = useState(current);
    current = v;
    return (
      <ChatInput
        onSubmit={(message) => { submitted = message; }}
        onCommand={() => {}}
        commandContext={noopContext}
        value={v}
        onChange={(value) => { current = value; setV(value); }}
        isProcessing={true}
      />
    );
  }
  const { stdin } = render(<Harness />);
  await Promise.resolve();
  stdin.write("\x1B\r");
  await Promise.resolve();
  await Promise.resolve();
  expect(submitted).toBe("follow up");
  expect(current).toBe("");
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

test("ChatInput caps the box at 40vh and scrolls internally", () => {
  // rows=10 -> 40vh = 4 visible lines. Six lines exceed the cap.
  const value = Array.from({ length: 6 }, (_, i) => `line${i}`).join("\n");
  const { lastFrame } = render(
    <ChatInput
      onSubmit={() => {}}
      onCommand={() => {}}
      commandContext={noopContext}
      value={value}
      onChange={() => {}}
      rows={10}
    />,
  );
  const frame = lastFrame() ?? "";
  // The first line is scrolled out of view; the cursor sits on the last line.
  expect(frame).not.toContain("line0");
  expect(frame).toContain("line5");
  // An edge indicator marks that content exists above the window.
  expect(frame).toContain("↑");
});

test("ChatInput action bar shows the verb beside the steer hint and the model on the right", () => {
  const { lastFrame } = render(
    <ChatInput
      onSubmit={() => {}}
      onCommand={() => {}}
      commandContext={noopContext}
      value="follow up"
      onChange={() => {}}
      isProcessing={true}
      queuedCount={1}
      verb="thinking"
      model="gpt-5"
      effort="high"
    />,
  );
  const frame = lastFrame() ?? "";
  // Verb prefixes the steer hint on the left; model · effort on the right,
  // both above the prompt box on the same baseline.
  expect(frame).toContain("thinking · 1 queued · Enter steer · Alt+Enter queue");
  expect(frame).toContain("gpt-5 · high");
  expect(frame.indexOf("thinking")).toBeLessThan(frame.indexOf("> follow up"));
  expect(frame.indexOf("gpt-5 · high")).toBeLessThan(frame.indexOf("> follow up"));
});
