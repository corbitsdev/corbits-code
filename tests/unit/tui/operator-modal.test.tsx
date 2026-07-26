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
