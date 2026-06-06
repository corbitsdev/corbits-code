import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { OperatorModal } from "../../../src/tui/components/operator-modal.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

const OPTIONS = ["Option A", "Option B", "Option C"];

function renderModal(
  options = OPTIONS,
  onSelect: (i: number) => void = () => {},
) {
  return render(
    <OperatorModal question="Which option?" options={options} onSelect={onSelect} />,
  );
}

test("renders question text", () => {
  const { lastFrame } = renderModal();
  expect(lastFrame()).toContain("Which option?");
});

test("renders all options", () => {
  const { lastFrame } = renderModal();
  expect(lastFrame()).toContain("Option A");
  expect(lastFrame()).toContain("Option B");
  expect(lastFrame()).toContain("Option C");
});

test("first option is selected by default (> prefix)", () => {
  const { lastFrame } = renderModal();
  expect(lastFrame()).toContain("> Option A");
});

test("down arrow moves selection to second option", async () => {
  let selected = -1;
  const { stdin } = renderModal(OPTIONS, (i) => { selected = i; });
  stdin.write("\x1B[B");
  await tick();
  stdin.write("\r");
  await tick();
  expect(selected).toBe(1);
});

test("down arrow wraps from last to first", async () => {
  let selected = -1;
  const { stdin } = renderModal(OPTIONS, (i) => { selected = i; });
  stdin.write("\x1B[B");
  await tick();
  stdin.write("\x1B[B");
  await tick();
  stdin.write("\x1B[B");
  await tick();
  stdin.write("\r");
  await tick();
  expect(selected).toBe(0);
});

test("up arrow wraps from first to last", async () => {
  let selected = -1;
  const { stdin } = renderModal(OPTIONS, (i) => { selected = i; });
  stdin.write("\x1B[A");
  await tick();
  stdin.write("\r");
  await tick();
  expect(selected).toBe(OPTIONS.length - 1);
});

test("Enter calls onSelect with currently selected index", async () => {
  let selected = -1;
  const { stdin } = renderModal(OPTIONS, (i) => { selected = i; });
  stdin.write("\r");
  await tick();
  expect(selected).toBe(0);
});
