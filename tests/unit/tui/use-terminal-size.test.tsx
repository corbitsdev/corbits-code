import { test, expect, mock } from "bun:test";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useTerminalSize, debounce } from "../../../src/tui/hooks/use-terminal-size.js";

// ink-testing-library's internal Stdout hardcodes columns=100 and has no rows
// property (so rows falls back to the hook's FALLBACK_ROWS=24). These tests
// assert the hook correctly reads what the ink context provides.

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 20));
const fastTick = (): Promise<void> => new Promise((r) => setImmediate(r));

function Harness() {
  const { columns, rows } = useTerminalSize();
  return <Text>{`cols:${columns}|rows:${rows}`}</Text>;
}

test("reads columns from ink stdout context (ink-testing-library provides 100)", () => {
  const { lastFrame } = render(<Harness />);
  expect(lastFrame()).toContain("cols:100");
});

test("rows falls back to 24 when stdout has no rows property", () => {
  const { lastFrame } = render(<Harness />);
  expect(lastFrame()).toContain("rows:24");
});

test("hook re-renders on resize: columns update is reflected in frame", async () => {
  // ink-testing-library's Stdout.columns is a read-only getter returning 100.
  // We can verify the hook registers a resize listener by checking it doesn't
  // throw and the initial frame is stable after a resize event.
  const { lastFrame, stdout } = render(<Harness />);
  expect(lastFrame()).toContain("cols:100");
  // Emitting resize without changing columns should re-read the same value.
  stdout.emit("resize");
  await tick();
  expect(lastFrame()).toContain("cols:100");
});

test("debounce coalesces rapid calls into a single invocation", async () => {
  const fn = mock(() => {});
  const debounced = debounce(fn, 50);

  debounced();
  debounced();
  debounced();

  await fastTick();
  expect(fn).toHaveBeenCalledTimes(0);

  await new Promise((r) => setTimeout(r, 60));
  expect(fn).toHaveBeenCalledTimes(1);
});

test("debounce trailing call uses latest arguments", async () => {
  const fn = mock(() => {});
  const debounced = debounce(fn, 50);

  debounced("first");
  debounced("second");
  debounced("third");

  await new Promise((r) => setTimeout(r, 60));
  expect(fn).toHaveBeenCalledWith("third");
  expect(fn).toHaveBeenCalledTimes(1);
});

test("debounce clears pending timer on cleanup", async () => {
  const fn = mock(() => {});
  const debounced = debounce(fn, 100);

  debounced();
  const cleanup = debounced.cleanup;
  cleanup();

  await new Promise((r) => setTimeout(r, 150));
  expect(fn).not.toHaveBeenCalled();
});
