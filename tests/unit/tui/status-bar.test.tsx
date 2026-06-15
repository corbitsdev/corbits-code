import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { StatusBar } from "../../../src/tui/components/status-bar.js";
import type { StatusBarProps } from "../../../src/tui/components/status-bar.js";

function renderBar(props: Partial<StatusBarProps> = {}) {
  return render(
    <StatusBar
      provider={props.provider ?? "zen"}
      model={props.model ?? "test-model"}
      cost={props.cost}
      inputTokens={props.inputTokens ?? 0}
      outputTokens={props.outputTokens ?? 0}
      status={props.status ?? "running"}
      contextUsage={props.contextUsage}
      {...(props.reasoningEffort !== undefined ? { reasoningEffort: props.reasoningEffort } : {})}
    />,
  );
}

test("StatusBar renders provider, model and split token telemetry", () => {
  const { lastFrame } = renderBar({ inputTokens: 4200, outputTokens: 318, cost: "$0.12" });
  expect(lastFrame()).toContain("zen · test-model");
  expect(lastFrame()).toContain("↑4200");
  expect(lastFrame()).toContain("↓318");
  expect(lastFrame()).toContain("$0.12");
});

test("StatusBar does not render the keyboard hint row", () => {
  const { lastFrame } = renderBar();
  expect(lastFrame()).not.toContain("Ctrl+C");
});

test("StatusBar hides the running status label", () => {
  const { lastFrame } = renderBar({ status: "running" });
  expect(lastFrame()).not.toContain("Running");
});

test("StatusBar renders the blocked status label", () => {
  const { lastFrame } = renderBar({ status: "blocked" });
  expect(lastFrame()).toContain("Blocked");
});

test("StatusBar does not render plan progress", () => {
  const { lastFrame } = renderBar();
  expect(lastFrame()).not.toContain("Plan:");
  expect(lastFrame()).not.toContain("turns");
});

test("StatusBar renders context-window usage when provided", () => {
  const { lastFrame } = renderBar({ contextUsage: "Context: 280000/400000" });
  expect(lastFrame()).toContain("Context: 280000/400000");
});

test("StatusBar omits the cost box when cost is undefined", () => {
  const { lastFrame } = renderBar({ cost: undefined });
  expect(lastFrame()).not.toContain("$");
});

test("StatusBar renders the reasoning-effort in the provider line", () => {
  const { lastFrame } = renderBar({ reasoningEffort: "high" });
  expect(lastFrame()).toContain("· HIGH");
});

test("StatusBar hides effort suffix when unset", () => {
  const { lastFrame } = renderBar();
  expect(lastFrame()).not.toContain("· HIGH");
});
