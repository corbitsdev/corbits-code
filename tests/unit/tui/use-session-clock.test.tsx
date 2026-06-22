import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useSessionClock } from "../../../src/tui/hooks/use-session-clock.js";

function Clock({ startedAt }: { startedAt: number }) {
  const elapsed = useSessionClock(startedAt);
  return <Text>{elapsed}</Text>;
}

test("useSessionClock reports elapsed since the start timestamp", () => {
  const startedAt = Date.now() - 5000;
  const { lastFrame } = render(<Clock startedAt={startedAt} />);
  const elapsed = Number(lastFrame());
  expect(elapsed).toBeGreaterThanOrEqual(5000);
});

test("useSessionClock resets when startedAt changes", () => {
  const oldStart = Date.now() - 10_000;
  const { lastFrame, rerender } = render(<Clock startedAt={oldStart} />);
  expect(Number(lastFrame())).toBeGreaterThanOrEqual(10_000);

  const newStart = Date.now() - 500;
  rerender(<Clock startedAt={newStart} />);
  // After the reset the clock reads near-zero, not the prior 10s.
  const afterReset = Number(lastFrame());
  expect(afterReset).toBeGreaterThanOrEqual(500);
  expect(afterReset).toBeLessThan(5000);
});
