import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useSpinner, SPINNER_FRAMES } from "../../../src/tui/hooks/use-spinner.js";

function Harness({ active }: { active: boolean }) {
  const { frame, elapsedMs } = useSpinner(active);
  return <Text>{`frame:${frame}|elapsed:${elapsedMs}`}</Text>;
}

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("SPINNER_FRAMES has 10 entries", () => {
  expect(SPINNER_FRAMES.length).toBe(10);
});

test("inactive: frame is first frame and elapsedMs is 0", () => {
  const { lastFrame } = render(<Harness active={false} />);
  expect(lastFrame()).toContain(`frame:${SPINNER_FRAMES[0]}`);
  expect(lastFrame()).toContain("elapsed:0");
});

test("active: frame advances after interval", async () => {
  const { lastFrame } = render(<Harness active={true} />);
  const initial = lastFrame();
  await tick(200);
  const after = lastFrame();
  expect(after).not.toBe(initial);
});

test("active: elapsedMs increases over time", async () => {
  const { lastFrame } = render(<Harness active={true} />);
  await tick(200);
  const frame = lastFrame() ?? "";
  const match = /elapsed:(\d+)/.exec(frame);
  expect(match).not.toBeNull();
  expect(Number(match![1])).toBeGreaterThan(0);
});

test("flipping active to false resets frame and elapsedMs", async () => {
  const { lastFrame, rerender } = render(<Harness active={true} />);
  await tick(200);
  rerender(<Harness active={false} />);
  await tick(20);
  expect(lastFrame()).toContain(`frame:${SPINNER_FRAMES[0]}`);
  expect(lastFrame()).toContain("elapsed:0");
});

// C2: re-toggling active (false -> true) should NOT reset elapsedMs to 0 if the
// spinner was only briefly inactive. The elapsed counter should be cumulative
// across the whole working session, not per re-arm cycle.
//
// This test simulates the pattern the TUI produces: active goes true, then
// briefly false (tool result arrives), then true again (model re-thinks).
// Elapsed must keep climbing — it must not snap back to 0 on the second arm.
test("C2: elapsedMs does not reset to 0 when active re-arms after brief idle", async () => {
  const { lastFrame, rerender } = render(<Harness active={true} />);
  await tick(200);

  // Simulate brief idle (tool result received).
  rerender(<Harness active={false} />);
  await tick(20);

  // Re-arm for next model turn.
  rerender(<Harness active={true} />);
  await tick(20);

  const frame = lastFrame() ?? "";
  const match = /elapsed:(\d+)/.exec(frame);
  expect(match).not.toBeNull();
  // Should still reflect cumulative time (>0), not a fresh 0.
  expect(Number(match![1])).toBeGreaterThan(0);
});
