import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import {
  InFlightIndicator,
  shouldShowProgressRow,
} from "../../../src/tui/components/in-flight-indicator.js";
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

test("renders nothing while inactive with no workflow", () => {
  const { lastFrame } = render(<InFlightIndicator active={false} timingAnchor={null} />);
  expect((lastFrame() ?? "").trim()).toBe("");
});

test("shouldShowProgressRow gates the permanent spacer", () => {
  expect(shouldShowProgressRow({ active: false, hasWorkflow: false })).toBe(false);
  expect(shouldShowProgressRow({ active: true, hasWorkflow: false })).toBe(true);
  expect(shouldShowProgressRow({ active: false, hasWorkflow: true })).toBe(true);
});

test("surfaces an elapsed counter only once the wait runs long", () => {
  const quick = render(<InFlightIndicator active timingAnchor={Date.now() - 900} />).lastFrame() ?? "";
  expect(quick).not.toContain("s");

  const slow = render(<InFlightIndicator active timingAnchor={Date.now() - 4200} />).lastFrame() ?? "";
  expect(slow).toContain("4s");
});
