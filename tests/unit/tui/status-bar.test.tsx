import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { StatusBar } from "../../../src/tui/components/status-bar.js";

function renderBar(props: { sessionElapsedMs?: number; mcpCount?: number } = {}) {
  return render(
    <StatusBar
      sessionElapsedMs={props.sessionElapsedMs ?? 0}
      mcpCount={props.mcpCount ?? 0}
    />,
  );
}

test("StatusBar renders the product name on the left", () => {
  const { lastFrame } = renderBar();
  const frame = lastFrame() ?? "";
  expect(frame).toContain("Intercode");
  // Brand is the first non-whitespace content — left-aligned.
  expect(frame.trimStart().startsWith("Intercode")).toBe(true);
});

test("StatusBar shows the session elapsed time beside the brand", () => {
  const { lastFrame } = renderBar({ sessionElapsedMs: 65_000 });
  expect(lastFrame()).toContain("1m 5s");
});

test("StatusBar shows MCP health on the right when servers are connected", () => {
  const { lastFrame } = renderBar({ mcpCount: 3 });
  const frame = lastFrame() ?? "";
  expect(frame).toContain("MCP ✓ 3");
  expect(frame.indexOf("Intercode")).toBeLessThan(frame.indexOf("MCP"));
});

test("StatusBar hides MCP when none are connected", () => {
  const { lastFrame } = renderBar({ mcpCount: 0 });
  expect(lastFrame()).not.toContain("MCP");
});

test("StatusBar does not render token counts or cost", () => {
  const { lastFrame } = renderBar();
  const frame = lastFrame() ?? "";
  expect(frame).not.toContain("↑");
  expect(frame).not.toContain("↓");
  expect(frame).not.toContain("$");
});
