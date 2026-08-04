import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import {
  InFlightIndicator,
  resolveInlineWorkflowChip,
} from "../../../src/tui/components/in-flight-indicator.js";
import { shouldShowProgressRow } from "../../../src/tui/chrome-zones.js";
import { SPINNER_FRAMES } from "../../../src/tui/hooks/use-spinner.js";
import type { WorkflowStatus } from "../../../src/tui/workflow-controller.js";

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

const emptyWorkflow = (over: Partial<WorkflowStatus> = {}): WorkflowStatus => ({
  active: false,
  name: undefined,
  stepIndex: 0,
  total: 0,
  label: "",
  steps: [],
  capabilities: [],
  ...over,
});

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

test("resolveInlineWorkflowChip returns the live named workflow", () => {
  const chip = resolveInlineWorkflowChip(
    emptyWorkflow({ active: true, name: "review", stepIndex: 1, total: 3, label: "critique" }),
  );
  expect(chip).toEqual({ name: "review", stepIndex: 1, total: 3, label: "critique" });
});

test("resolveInlineWorkflowChip does not pin a done chip after workflows finish", () => {
  expect(
    resolveInlineWorkflowChip(
      emptyWorkflow({ active: false, name: "ship", total: 4, label: "done" }),
    ),
  ).toBeUndefined();
});

test("resolveInlineWorkflowChip is undefined with no named active workflow", () => {
  expect(resolveInlineWorkflowChip(emptyWorkflow())).toBeUndefined();
  expect(resolveInlineWorkflowChip(emptyWorkflow({ active: true }))).toBeUndefined();
});



test("surfaces an elapsed counter only once the wait runs long", () => {
  const quick = render(<InFlightIndicator active timingAnchor={Date.now() - 900} />).lastFrame() ?? "";
  expect(quick).not.toContain("s");

  const slow = render(<InFlightIndicator active timingAnchor={Date.now() - 4200} />).lastFrame() ?? "";
  expect(slow).toContain("4s");
});
