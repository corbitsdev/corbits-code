import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { InFlightIndicator } from "../../../src/tui/components/in-flight-indicator.js";

test("shows the spinner frame and label while active", () => {
  const { lastFrame } = render(<InFlightIndicator active frame="⠋" elapsedMs={0} />);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("⠋");
  expect(frame).toContain("Thinking…");
});

test("renders nothing visible while inactive", () => {
  const { lastFrame } = render(<InFlightIndicator active={false} frame="⠋" elapsedMs={0} />);
  const frame = lastFrame() ?? "";
  expect(frame).not.toContain("Thinking…");
  expect(frame).not.toContain("⠋");
});

test("surfaces an elapsed counter only once the wait runs long", () => {
  const quick = render(<InFlightIndicator active frame="⠋" elapsedMs={900} />).lastFrame() ?? "";
  expect(quick).not.toContain("s");

  const slow = render(<InFlightIndicator active frame="⠋" elapsedMs={4200} />).lastFrame() ?? "";
  expect(slow).toContain("4s");
});
