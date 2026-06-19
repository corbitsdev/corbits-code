import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { StatusBar } from "../../../src/tui/components/status-bar.js";
import type { StatusBarProps } from "../../../src/tui/components/status-bar.js";

function renderBar(props: Partial<StatusBarProps> = {}) {
  return render(
    <StatusBar
      model={props.model ?? "test-model"}
      status={props.status ?? "running"}
      {...(props.reasoningEffort !== undefined ? { reasoningEffort: props.reasoningEffort } : {})}
      {...(props.agentMode !== undefined ? { agentMode: props.agentMode } : {})}
    />,
  );
}

test("StatusBar renders the model name", () => {
  const { lastFrame } = renderBar({ model: "test-model" });
  expect(lastFrame()).toContain("test-model");
});

test("StatusBar renders the product name (moved from the header)", () => {
  const { lastFrame } = renderBar();
  expect(lastFrame()).toContain("Intercode");
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

test("StatusBar does not render token counts or cost", () => {
  const { lastFrame } = renderBar();
  expect(lastFrame()).not.toContain("↑");
  expect(lastFrame()).not.toContain("↓");
  expect(lastFrame()).not.toContain("$");
});

test("StatusBar renders reasoning effort without dot separators", () => {
  const { lastFrame } = renderBar({ reasoningEffort: "high" });
  expect(lastFrame()).toContain("high");
  expect(lastFrame()).not.toContain("· high");
  expect(lastFrame()).not.toContain("|");
});

test("StatusBar hides effort when unset", () => {
  const { lastFrame } = renderBar();
  expect(lastFrame()).not.toContain("HIGH");
  expect(lastFrame()).not.toContain("high");
});
