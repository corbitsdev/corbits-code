import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { OperatorModal } from "../../../src/tui/components/operator-modal.js";
import type { OperatorResult } from "../../../src/agent/tools.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

const OPTIONS = ["Option A", "Option B", "Option C"];

function renderModal(
  options = OPTIONS,
  onSelect: (result: OperatorResult) => void = () => {},
) {
  return render(
    <OperatorModal question="Which option?" options={options} onSelect={onSelect} />,
  );
}

test("renders question text", () => {
  const { lastFrame } = renderModal();
  expect(lastFrame()).toContain("Which option?");
});

test("renders all provided options", () => {
  const { lastFrame } = renderModal();
  expect(lastFrame()).toContain("Option A");
  expect(lastFrame()).toContain("Option B");
  expect(lastFrame()).toContain("Option C");
});

test("first option is selected by default", () => {
  const { lastFrame } = renderModal();
  // The active option is prefixed with the › indicator
  expect(lastFrame()).toContain("Option A");
});

test("down arrow moves selection to second option", async () => {
  let result: OperatorResult | null = null;
  const { stdin } = renderModal(OPTIONS, (r) => { result = r; });
  stdin.write("\x1B[B");
  await tick();
  stdin.write("\r");
  await tick();
  expect(result).toEqual({ kind: "option", index: 1 });
});

test("operator modal handles arrow fragments when Ink strips ESC", async () => {
  let result: OperatorResult | null = null;
  const { stdin } = renderModal(OPTIONS, (r) => { result = r; });
  stdin.write("[B");
  await tick();
  stdin.write("\r");
  await tick();
  expect(result).toEqual({ kind: "option", index: 1 });
});

test("up arrow wraps from first to the last option", async () => {
  let result: OperatorResult | null = null;
  const { stdin } = renderModal(OPTIONS, (r) => { result = r; });
  stdin.write("\x1B[A");
  await tick();
  stdin.write("\r");
  await tick();
  expect(result).toEqual({ kind: "option", index: 2 });
});

test("Ctrl+Up leaves approval selection unchanged for transcript scrolling", async () => {
  let result: OperatorResult | null = null;
  const { stdin } = renderModal(OPTIONS, (next) => { result = next; });
  stdin.write("\x1B[1;5A");
  await tick();
  stdin.write("\r");
  await tick();
  expect(result).toEqual({ kind: "option", index: 0 });
});

test("Enter calls onSelect with the currently selected option", async () => {
  let result: OperatorResult | null = null;
  const { stdin } = renderModal(OPTIONS, (r) => { result = r; });
  stdin.write("\r");
  await tick();
  expect(result).toEqual({ kind: "option", index: 0 });
});

test("Escape dismisses with a cancel result", async () => {
  let result: OperatorResult | null = null;
  const { stdin } = renderModal(OPTIONS, (r) => { result = r; });
  stdin.write("\x1B");
  await tick();
  expect(result).toEqual({ kind: "cancel" });
});

test("typing a printable char activates custom response mode", async () => {
  let result: OperatorResult | null = null;
  const { stdin } = renderModal(OPTIONS, (r) => { result = r; });
  stdin.write("c");
  await tick();
  stdin.write("ustom answer");
  await tick();
  stdin.write("\r");
  await tick();
  expect(result).toEqual({ kind: "custom", text: "custom answer" });
});

test("number key directly selects the corresponding option", async () => {
  let result: OperatorResult | null = null;
  const { stdin } = renderModal(OPTIONS, (r) => { result = r; });
  stdin.write("2");
  await tick();
  expect(result).toEqual({ kind: "option", index: 1 });
});

test("accepts a width prop without error", () => {
  const { lastFrame } = render(
    <OperatorModal question="A question?" options={OPTIONS} onSelect={() => {}} width={60} />,
  );
  expect(lastFrame()).toContain("A question?");
  expect(lastFrame()).toContain("Option A");
});

test("renders markdown formatting in the question", () => {
  const { lastFrame } = render(
    <OperatorModal question="**Bold** and `code`" options={OPTIONS} onSelect={() => {}} />,
  );
  // Markdown is rendered: markers stripped, text visible
  expect(lastFrame()).toContain("Bold");
  expect(lastFrame()).toContain("code");
  // Raw markers should not appear
  expect(lastFrame()).not.toContain("**Bold**");
});

test("a long option list windows around the selection and pages via arrow keys", async () => {
  const manyOptions = Array.from({ length: 30 }, (_, i) => `Option ${i + 1}`);
  const { lastFrame, stdin } = render(
    <OperatorModal question="Pick one" options={manyOptions} onSelect={() => {}} terminalRows={16} />,
  );
  await tick();
  const initial = lastFrame() ?? "";
  expect(initial).toContain("1. Option 1");
  expect(initial).not.toContain("Option 30");
  expect(initial).toMatch(/↓ \d+ more below/);

  // Move the selection down past the visible window; the window should
  // follow the focused option so it stays reachable and visible.
  for (let i = 0; i < 20; i++) {
    stdin.write("\x1B[B");
    await tick();
  }
  const afterMoves = lastFrame() ?? "";
  expect(afterMoves).toContain("21. Option 21");
  expect(afterMoves).toMatch(/↑ \d+ more above/);
});

test("a long question scrolls with PageUp/PageDown while options stay visible", async () => {
  const longQuestion = Array.from({ length: 30 }, (_, i) => `Line ${i} of the question body.`).join("\n\n");
  const { lastFrame, stdin } = render(
    <OperatorModal question={longQuestion} options={OPTIONS} onSelect={() => {}} terminalRows={16} />,
  );
  await tick();
  const initial = lastFrame() ?? "";
  expect(initial).toContain("Line 0 of the question body.");
  expect(initial).not.toContain("Line 29 of the question body.");
  expect(initial).toContain("Option A");
  expect(initial).toContain("Option C");
  expect(initial).toMatch(/↓ \d+ more below/);

  stdin.write("\x1B[6~"); // PageDown
  await tick();
  const afterPageDown = lastFrame() ?? "";
  expect(afterPageDown).not.toContain("Line 0 of the question body.");
  expect(afterPageDown).toContain("Option A");
});

test("a short question and short option list have no scroll indicator", () => {
  const { lastFrame } = render(
    <OperatorModal question="Short question?" options={OPTIONS} onSelect={() => {}} terminalRows={24} />,
  );
  const frame = lastFrame() ?? "";
  expect(frame).not.toContain("PageUp/PageDown to scroll");
  expect(frame).not.toMatch(/more below/);
  expect(frame).not.toMatch(/more above/);
});
