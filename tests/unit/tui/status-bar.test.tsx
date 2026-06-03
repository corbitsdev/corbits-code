import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { StatusBar } from "../../../src/tui/components/status-bar.js";
import type { StatusBarProps } from "../../../src/tui/components/status-bar.js";

function renderBar(props: Partial<StatusBarProps> = {}) {
  return render(
    <StatusBar
      model={props.model ?? "test-model"}
      planStep={props.planStep ?? null}
      planTotal={props.planTotal ?? 0}
      planPending={props.planPending ?? false}
      planDeviated={props.planDeviated ?? false}
      cost={props.cost ?? "$0.0000"}
      tokens={props.tokens ?? 0}
      elapsedMs={props.elapsedMs ?? 0}
      status={props.status ?? "running"}
    />,
  );
}

test("StatusBar renders model and keyboard hints", () => {
  const { lastFrame } = renderBar();
  expect(lastFrame()).toContain("test-model");
  expect(lastFrame()).toContain("Ctrl+C exit");
  expect(lastFrame()).toContain("Ctrl+H hooks");
});

test("StatusBar renders the running status label", () => {
  const { lastFrame } = renderBar({ status: "running" });
  expect(lastFrame()).toContain("Running");
});

test("StatusBar renders the blocked status label", () => {
  const { lastFrame } = renderBar({ status: "blocked" });
  expect(lastFrame()).toContain("Blocked");
});

test("StatusBar shows plan progress", () => {
  const { lastFrame } = renderBar({ planStep: 1, planTotal: 3 });
  expect(lastFrame()).toContain("Plan: 2/3");
});

test("StatusBar shows pending plan", () => {
  const { lastFrame } = renderBar({ planPending: true });
  expect(lastFrame()).toContain("Plan: pending");
});

test("StatusBar formats elapsed time", () => {
  const { lastFrame } = renderBar({ elapsedMs: 65000 });
  expect(lastFrame()).toContain("1:05");
});
