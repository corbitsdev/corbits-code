import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { DiffView } from "../../../src/tui/components/diff-view.js";
import type { DiffResult } from "../../../src/tui/git-diff.js";

function renderDiff(result: DiffResult | null, opts: { scrollOffset?: number; visibleRows?: number; width?: number } = {}) {
  return render(
    <DiffView
      result={result}
      scrollOffset={opts.scrollOffset ?? 0}
      visibleRows={opts.visibleRows ?? 20}
      width={opts.width ?? 80}
    />,
  );
}

const emptyResult: DiffResult = { available: true, files: [] };

const resultWithLines: DiffResult = {
  available: true,
  files: [
    {
      path: "src/index.ts",
      lines: [
        { kind: "added", text: "+ added line" },
        { kind: "removed", text: "- removed line" },
        { kind: "context", text: "  context line" },
      ],
    },
  ],
};

test("renders Loading diff when result is null", () => {
  const { lastFrame } = renderDiff(null);
  expect(lastFrame()).toContain("Loading diff");
});

test("renders git unavailable message when available is false", () => {
  const { lastFrame } = renderDiff({ available: false, files: [] });
  expect(lastFrame()).toContain("Git unavailable");
});

test("renders No changes yet when result has no lines", () => {
  const { lastFrame } = renderDiff(emptyResult);
  expect(lastFrame()).toContain("No changes yet");
});

test("renders added line text", () => {
  const { lastFrame } = renderDiff(resultWithLines);
  expect(lastFrame()).toContain("+ added line");
});

test("renders removed line text", () => {
  const { lastFrame } = renderDiff(resultWithLines);
  expect(lastFrame()).toContain("- removed line");
});

test("scrollOffset clips visible slice — first line hidden when offset is 1", () => {
  const { lastFrame } = renderDiff(resultWithLines, { scrollOffset: 1, visibleRows: 2 });
  expect(lastFrame()).not.toContain("+ added line");
  expect(lastFrame()).toContain("- removed line");
});

test("long lines are truncated to fit width", () => {
  const longLine = "+" + "x".repeat(200);
  const result: DiffResult = {
    available: true,
    files: [{ path: "a.ts", lines: [{ kind: "added", text: longLine }] }],
  };
  const width = 40;
  const { lastFrame } = renderDiff(result, { width });
  const frame = lastFrame() ?? "";
  const lines = frame.split("\n");
  for (const line of lines) {
    expect(line.length).toBeLessThanOrEqual(width + 5);
  }
});
