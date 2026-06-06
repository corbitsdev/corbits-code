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

function Harness({ cwd, active, refreshKey }: { cwd: string; active: boolean; refreshKey: number }) {
  const { result, loading } = useDiff({ cwd, active, refreshKey });
  return (
    <Text>{`loading:${loading}|available:${result?.available ?? "null"}`}</Text>
  );
}

beforeEach(() => {
  mockGetWorkingTreeDiff.mockClear();
});

test("active false: no fetch issued, result stays null", async () => {
  const { lastFrame } = render(<Harness cwd="/repo" active={false} refreshKey={0} />);
  await tick();
  expect(lastFrame()).toContain("available:null");
  expect(mockGetWorkingTreeDiff).not.toHaveBeenCalled();
});

test("active true: loading becomes true then result is set", async () => {
  const { lastFrame } = render(<Harness cwd="/repo" active={true} refreshKey={0} />);
  await tick();
  expect(lastFrame()).toContain("available:true");
  expect(mockGetWorkingTreeDiff).toHaveBeenCalledWith("/repo");
});

test("refreshKey increment triggers new fetch", async () => {
  const { lastFrame, rerender } = render(<Harness cwd="/repo" active={true} refreshKey={0} />);
  await tick();
  expect(mockGetWorkingTreeDiff).toHaveBeenCalledTimes(1);
  rerender(<Harness cwd="/repo" active={true} refreshKey={1} />);
  await tick();
  expect(mockGetWorkingTreeDiff).toHaveBeenCalledTimes(2);
  expect(lastFrame()).toContain("available:true");
});

test("toggling active from true to false then back triggers new fetch", async () => {
  const { rerender } = render(<Harness cwd="/repo" active={true} refreshKey={0} />);
  await tick();
  expect(mockGetWorkingTreeDiff).toHaveBeenCalledTimes(1);
  rerender(<Harness cwd="/repo" active={false} refreshKey={0} />);
  await tick();
  rerender(<Harness cwd="/repo" active={true} refreshKey={0} />);
  await tick();
  expect(mockGetWorkingTreeDiff).toHaveBeenCalledTimes(2);
});
