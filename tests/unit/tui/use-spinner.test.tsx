import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { Text } from "ink";
import {
  elapsedMsFromAnchor,
  useSpinner,
  SPINNER_FRAMES,
} from "../../../src/tui/hooks/use-spinner.js";

function Harness({ active, resetKey }: { active: boolean; resetKey?: number }) {
  const { anchor } = useSpinner(active, resetKey);
  const elapsedMs = elapsedMsFromAnchor(anchor);
  return <Text>{`anchor:${anchor ?? "null"}|elapsed:${elapsedMs}`}</Text>;
}

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("SPINNER_FRAMES has 10 entries", () => {
  expect(SPINNER_FRAMES.length).toBe(10);
});

test("inactive: anchor is null and elapsedMs is 0", () => {
  const { lastFrame } = render(<Harness active={false} />);
  expect(lastFrame()).toContain("anchor:null");
  expect(lastFrame()).toContain("elapsed:0");
});

test("active: exposes a timing anchor", () => {
  const { lastFrame } = render(<Harness active={true} />);
  const frame = lastFrame() ?? "";
  expect(frame).toMatch(/anchor:\d+/);
});

test("active: elapsedMs increases over time", async () => {
  const { lastFrame, rerender } = render(<Harness active={true} />);
  await tick(200);
  rerender(<Harness active={true} />);
  const frame = lastFrame() ?? "";
  const match = /elapsed:(\d+)/.exec(frame);
  expect(match).not.toBeNull();
  expect(Number(match![1])).toBeGreaterThan(0);
});

test("flipping active to false clears anchor and elapsedMs", async () => {
  const { lastFrame, rerender } = render(<Harness active={true} />);
  await tick(200);
  rerender(<Harness active={false} />);
  await tick(20);
  expect(lastFrame()).toContain("anchor:null");
  expect(lastFrame()).toContain("elapsed:0");
});

// When resetKey changes, the cumulative elapsed must restart at 0 so a
// new user turn does not inherit the prior turn's running total.
test("changing resetKey resets elapsedMs to 0 even after prior accumulation", async () => {
  const { lastFrame, rerender } = render(<Harness active={true} resetKey={1} />);
  await tick(200);

  // Briefly idle to preserve accumulated time in pausedElapsedRef.
  rerender(<Harness active={false} resetKey={1} />);
  await tick(20);

  // New turn — resetKey increments. Even though pausedElapsedRef held prior
  // elapsed, the new key must zero it out before the spinner re-arms.
  rerender(<Harness active={true} resetKey={2} />);
  await tick(20);

  const frame = lastFrame() ?? "";
  const match = /elapsed:(\d+)/.exec(frame);
  expect(match).not.toBeNull();
  // Fresh turn: elapsed should be close to 0 (only ~20 ms since reset).
  expect(Number(match![1])).toBeLessThan(150);
});

// Within a single turn, re-arming with the same resetKey must still
// accumulate (preserves C2 behavior).
test("same resetKey preserves cumulative elapsed across re-arms", async () => {
  const { lastFrame, rerender } = render(<Harness active={true} resetKey={1} />);
  await tick(200);

  // Briefly idle — same key, same turn.
  rerender(<Harness active={false} resetKey={1} />);
  await tick(20);

  // Re-arm with same key — elapsed must resume from prior value, not 0.
  rerender(<Harness active={true} resetKey={1} />);
  await tick(20);

  const frame = lastFrame() ?? "";
  const match = /elapsed:(\d+)/.exec(frame);
  expect(match).not.toBeNull();
  expect(Number(match![1])).toBeGreaterThan(150);
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
