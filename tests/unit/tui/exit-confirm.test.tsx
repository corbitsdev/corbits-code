import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { ExitConfirm } from "../../../src/tui/components/exit-confirm.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

test("ExitConfirm renders the title and prompt", () => {
  const { lastFrame } = render(<ExitConfirm onConfirm={() => {}} onCancel={() => {}} />);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("Exit Corbits Code?");
  expect(frame).toContain("(y/n)");
});

test("ExitConfirm confirms on Y", async () => {
  let confirmed = false;
  const { stdin } = render(<ExitConfirm onConfirm={() => { confirmed = true; }} onCancel={() => {}} />);
  stdin.write("y");
  await tick();
  expect(confirmed).toBe(true);
});

test("ExitConfirm confirms on Enter", async () => {
  let confirmed = false;
  const { stdin } = render(<ExitConfirm onConfirm={() => { confirmed = true; }} onCancel={() => {}} />);
  stdin.write("\r");
  await tick();
  expect(confirmed).toBe(true);
});

test("ExitConfirm cancels on n", async () => {
  let cancelled = false;
  const { stdin } = render(<ExitConfirm onConfirm={() => {}} onCancel={() => { cancelled = true; }} />);
  stdin.write("n");
  await tick();
  expect(cancelled).toBe(true);
});

test("ExitConfirm cancels on Escape", async () => {
  let cancelled = false;
  const { stdin } = render(<ExitConfirm onConfirm={() => {}} onCancel={() => { cancelled = true; }} />);
  stdin.write("\x1B");
  await tick();
  expect(cancelled).toBe(true);
});
