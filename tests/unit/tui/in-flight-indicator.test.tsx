import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { InFlightIndicator } from "../../../src/tui/components/in-flight-indicator.js";
import { SPINNER_FRAMES } from "../../../src/tui/hooks/use-spinner.js";

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("shows the spinner frame and label while active", () => {
  const { lastFrame } = render(<InFlightIndicator active timingAnchor={Date.now()} />);
  const frame = lastFrame() ?? "";
  expect(SPINNER_FRAMES.some((g) => frame.includes(g))).toBe(true);
  expect(frame).toContain("Thinking…");
});

test("spinner glyph advances on its own tick without parent rerender", async () => {
  const { lastFrame } = render(<InFlightIndicator active timingAnchor={Date.now()} />);
  const initial = lastFrame() ?? "";
  await tick(200);
  const after = lastFrame() ?? "";
  expect(after).not.toBe(initial);
});

test("renders nothing visible while inactive", () => {
  const { lastFrame } = render(<InFlightIndicator active={false} timingAnchor={null} />);
  const frame = lastFrame() ?? "";
  expect(frame).not.toContain("Thinking…");
  expect(frame).not.toContain("⠋");
});

test("surfaces an elapsed counter only once the wait runs long", () => {
  const quick = render(<InFlightIndicator active timingAnchor={Date.now() - 900} />).lastFrame() ?? "";
  expect(quick).not.toContain("s");

  const slow = render(<InFlightIndicator active timingAnchor={Date.now() - 4200} />).lastFrame() ?? "";
  expect(slow).toContain("4s");
});
