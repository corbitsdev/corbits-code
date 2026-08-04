import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { Box } from "ink";
import { CHROME_ZONE_ROWS } from "../../../src/tui/chrome-zones.js";
import { InFlightIndicator } from "../../../src/tui/components/in-flight-indicator.js";
import { StatusBar } from "../../../src/tui/components/status-bar.js";

// These tests derive the zone budgets from the components' painted output
// rather than restating the constants, so a markup change that adds or
// removes a row fails here instead of silently desyncing the layout math.

function frameRows(frame: string | undefined): number {
  return (frame ?? "").split("\n").length;
}

test("progress budget matches the rows InFlightIndicator paints when shown", () => {
  // Idle with nothing to show collapses entirely — no permanent spacer.
  const idle = render(<InFlightIndicator active={false} timingAnchor={null} />);
  expect((idle.lastFrame() ?? "").trim()).toBe("");

  const active = render(<InFlightIndicator active={true} timingAnchor={Date.now()} />);
  expect(frameRows(active.lastFrame())).toBe(CHROME_ZONE_ROWS.progress);

  const workflowOnly = render(
    <InFlightIndicator
      active={false}
      timingAnchor={null}
      workflow={{ name: "demo", stepIndex: 0, total: 2, label: "step" }}
    />,
  );
  expect(frameRows(workflowOnly.lastFrame())).toBe(CHROME_ZONE_ROWS.progress);
});

test("status budget matches the rows StatusBar paints inside App's marginTop wrapper", () => {
  // App wraps StatusBar in <Box marginTop={1}>; mirror that wrapper here.
  const { lastFrame } = render(
    <Box marginTop={1}>
      <StatusBar sessionElapsedMs={0} mcpCount={0} />
    </Box>,
  );
  expect(frameRows(lastFrame())).toBe(CHROME_ZONE_ROWS.status);
});
