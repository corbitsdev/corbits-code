import { test, expect, mock, beforeEach } from "bun:test";
import { render } from "ink-testing-library";
import { Text } from "ink";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

const mockGetWorkingTreeDiff = mock(async (_cwd: string) => ({
  available: true,
  files: [{ path: "a.ts", lines: [{ kind: "added" as const, text: "+ line" }] }],
}));

mock.module("../../../src/tui/git-diff.js", () => ({
  getWorkingTreeDiff: mockGetWorkingTreeDiff,
}));

const { useDiff } = await import("../../../src/tui/hooks/use-diff.js");

function Harness({ cwd, active }: { cwd: string; active: boolean }) {
  const { result, loading } = useDiff({ cwd, active });
  return (
    <Text>{`loading:${loading}|available:${result?.available ?? "null"}`}</Text>
  );
}

beforeEach(() => {
  mockGetWorkingTreeDiff.mockClear();
});

test("active false: no fetch issued, result stays null", async () => {
  const { lastFrame } = render(<Harness cwd="/repo" active={false} />);
  await tick();
  expect(lastFrame()).toContain("available:null");
  expect(mockGetWorkingTreeDiff).not.toHaveBeenCalled();
});

test("active true: loading becomes true then result is set", async () => {
  const { lastFrame } = render(<Harness cwd="/repo" active={true} />);
  await tick();
  expect(lastFrame()).toContain("available:true");
  expect(mockGetWorkingTreeDiff).toHaveBeenCalledWith("/repo");
});

test("toggling active from true to false then back triggers new fetch", async () => {
  const { rerender } = render(<Harness cwd="/repo" active={true} />);
  await tick();
  expect(mockGetWorkingTreeDiff).toHaveBeenCalledTimes(1);
  rerender(<Harness cwd="/repo" active={false} />);
  await tick();
  rerender(<Harness cwd="/repo" active={true} />);
  await tick();
  // Re-opening the panel fires a fresh immediate refresh (lastRefreshAt resets
  // when the effect restarts because active flipped to false then back).
  expect(mockGetWorkingTreeDiff).toHaveBeenCalledTimes(2);
});
