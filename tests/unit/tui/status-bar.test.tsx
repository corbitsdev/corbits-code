import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { homedir } from "node:os";
import { StatusBar, planStatusBarLayout, truncateMiddle } from "../../../src/tui/components/status-bar.js";

function renderBar(
  props: {
    sessionElapsedMs?: number;
    mcpCount?: number;
    costLabel?: string;
    contextLabel?: string;
    model?: string;
    cwd?: string;
    gitBranch?: string | null;
    columns?: number;
  } = {},
) {
  return render(
    <StatusBar
      sessionElapsedMs={props.sessionElapsedMs ?? 0}
      mcpCount={props.mcpCount ?? 0}
      {...(props.costLabel !== undefined ? { costLabel: props.costLabel } : {})}
      {...(props.contextLabel !== undefined ? { contextLabel: props.contextLabel } : {})}
      {...(props.model !== undefined ? { model: props.model } : {})}
      {...(props.cwd !== undefined ? { cwd: props.cwd } : {})}
      {...(props.gitBranch !== undefined ? { gitBranch: props.gitBranch } : {})}
      {...(props.columns !== undefined ? { columns: props.columns } : {})}
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

test("StatusBar shows model, cwd, and git branch persistently", () => {
  const { lastFrame } = renderBar({ model: "claude-sonnet-5", cwd: "/tmp/project", gitBranch: "main" });
  const frame = lastFrame() ?? "";
  expect(frame).toContain("claude-sonnet-5");
  expect(frame).toContain("/tmp/project");
  expect(frame).toContain("main");
});

test("StatusBar abbreviates the home directory in cwd", () => {
  const home = homedir();
  const { lastFrame } = renderBar({ cwd: `${home}/abklabs/interchange-code` });
  const frame = lastFrame() ?? "";
  expect(frame).toContain("~/abklabs/interchange-code");
  expect(frame).not.toContain(home);
});

test("StatusBar omits model/cwd/branch segment when none are provided", () => {
  const { lastFrame } = renderBar();
  const frame = lastFrame() ?? "";
  expect(frame).not.toContain("·");
});

test("StatusBar preserves CL-3111 cost and context segments alongside the new segments", () => {
  const { lastFrame } = renderBar({
    costLabel: "$0.42",
    contextLabel: "Ctx 12%",
    model: "gpt-5",
    cwd: "/repo",
    gitBranch: "feature",
  });
  const frame = lastFrame() ?? "";
  expect(frame).toContain("$0.42");
  expect(frame).toContain("Ctx 12%");
  expect(frame).toContain("gpt-5");
  expect(frame).toContain("/repo");
  expect(frame).toContain("feature");
});

test("StatusBar drops cost/context and truncates cwd when the terminal is narrow", () => {
  const { lastFrame } = renderBar({
    costLabel: "$0.42",
    contextLabel: "Ctx 12%",
    model: "gpt-5",
    cwd: "/very/long/path/that/does/not/fit/on/a/narrow/terminal",
    gitBranch: "feature",
    columns: 40,
  });
  const frame = lastFrame() ?? "";
  expect(frame).toContain("Intercode");
  expect(frame).not.toContain("$0.42");
  expect(frame).not.toContain("Ctx 12%");
});

test("StatusBar renders a middle-truncated cwd while keeping model and branch intact", () => {
  const { lastFrame } = renderBar({
    model: "gpt-5",
    cwd: "/very/long/path/that/does/not/fit/on/a/narrow/terminal",
    gitBranch: "feature",
    columns: 48,
  });
  const frame = lastFrame() ?? "";
  expect(frame).toContain("gpt-5");
  expect(frame).toContain("feature");
  expect(frame).toContain("…");
  expect(frame).not.toContain("/very/long/path/that/does/not/fit/on/a/narrow/terminal");
  // Truncation eats the middle of the path, preserving both ends.
  expect(frame).toContain("/very");
  expect(frame).toContain("minal");
});

test("truncateMiddle keeps the head and tail around an ellipsis", () => {
  expect(truncateMiddle("abcdefghij", 7)).toBe("abc…hij");
  expect(truncateMiddle("short", 10)).toBe("short");
  expect(truncateMiddle("abc", 1)).toBe("a");
});

test("planStatusBarLayout keeps everything when it fits", () => {
  const layout = planStatusBarLayout({
    columns: 120,
    timerText: "5s",
    mcpText: "MCP ✓ 2",
    model: "gpt-5",
    cwd: "~/repo",
    gitBranch: "main",
    costLabel: "$0.42",
    contextLabel: "Ctx 12%",
  });
  expect(layout).toEqual({
    modelCwdBranchText: "gpt-5 · ~/repo · main",
    showCost: true,
    showContext: true,
  });
});

test("planStatusBarLayout counts padding and per-child gaps in the budget", () => {
  // brand(9) + timer(2) = 11 text columns; children are brand, timer, and the
  // flex spacer, so 2 gaps; plus 2 padding columns = 15 total.
  const fits = planStatusBarLayout({ columns: 15, timerText: "5s", contextLabel: "Ctx" });
  const overflows = planStatusBarLayout({ columns: 14, timerText: "5s", contextLabel: "Ctx" });
  expect(fits.showContext).toBe(false);
  // "Ctx"(3) + its gap(1) pushes the fitting width to 19.
  expect(planStatusBarLayout({ columns: 19, timerText: "5s", contextLabel: "Ctx" }).showContext).toBe(true);
  expect(overflows.showContext).toBe(false);
});

test("planStatusBarLayout drops context before cost before the model segment", () => {
  const base = {
    timerText: "5s",
    model: "gpt-5",
    cwd: "~/some/project/path",
    gitBranch: "main",
    costLabel: "$0.42",
    contextLabel: "Ctx 12%",
  };
  const wide = planStatusBarLayout({ ...base, columns: 80 });
  expect(wide.showContext).toBe(true);

  const narrower = planStatusBarLayout({ ...base, columns: 56 });
  expect(narrower.showContext).toBe(false);
  expect(narrower.showCost).toBe(true);

  const narrowest = planStatusBarLayout({ ...base, columns: 48 });
  expect(narrowest.showCost).toBe(false);
  expect(narrowest.modelCwdBranchText).toBeDefined();
});

test("planStatusBarLayout truncates only the cwd, never model or branch", () => {
  const layout = planStatusBarLayout({
    columns: 60,
    timerText: "5s",
    model: "gpt-5",
    cwd: "~/a/very/deeply/nested/project/directory",
    gitBranch: "feature-branch",
  });
  const segment = layout.modelCwdBranchText ?? "";
  expect(segment.startsWith("gpt-5 · ")).toBe(true);
  expect(segment.endsWith(" · feature-branch")).toBe(true);
  expect(segment).toContain("…");
});

test("planStatusBarLayout drops the model segment when cwd cannot absorb the overflow", () => {
  const layout = planStatusBarLayout({
    columns: 20,
    timerText: "5s",
    model: "gpt-5-with-long-name",
    cwd: "~/repo",
    gitBranch: "main",
  });
  expect(layout.modelCwdBranchText).toBeUndefined();
});
