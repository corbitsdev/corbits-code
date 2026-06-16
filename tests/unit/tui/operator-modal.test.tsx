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

test("renders all options plus the Other and Close entries", () => {
  const { lastFrame } = renderModal();
  expect(lastFrame()).toContain("Option A");
  expect(lastFrame()).toContain("Option B");
  expect(lastFrame()).toContain("Option C");
  expect(lastFrame()).toContain("Other");
  expect(lastFrame()).toContain("Close");
});

test("first option is selected by default (> prefix)", () => {
  const { lastFrame } = renderModal();
  expect(lastFrame()).toContain("> Option A");
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

test("up arrow wraps from first to the Close entry, which cancels", async () => {
  let result: OperatorResult | null = null;
  const { stdin } = renderModal(OPTIONS, (r) => { result = r; });
  stdin.write("\x1B[A");
  await tick();
  stdin.write("\r");
  await tick();
  expect(result).toEqual({ kind: "cancel" });
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

test("selecting Other lets the operator type a free-form answer", async () => {
  let result: OperatorResult | null = null;
  const { stdin } = renderModal(OPTIONS, (r) => { result = r; });
  // Move up once from the first option to land on Close, then up again to Other.
  stdin.write("\x1B[A");
  await tick();
  stdin.write("\x1B[A");
  await tick();
  stdin.write("\r");
  await tick();
  stdin.write("custom answer");
  await tick();
  stdin.write("\r");
  await tick();
  expect(result).toEqual({ kind: "custom", text: "custom answer" });
});

test("accepts a width prop without error", () => {
  const { lastFrame } = render(
    <OperatorModal question="A question?" options={OPTIONS} onSelect={() => {}} width={60} />,
  );
  expect(lastFrame()).toContain("A question?");
  expect(lastFrame()).toContain("Option A");
});
