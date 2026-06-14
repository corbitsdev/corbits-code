import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { ContextPanel } from "../../../src/tui/components/context-panel.js";

test("ContextPanel renders the plan view in plan mode", () => {
  const { lastFrame } = render(
    <ContextPanel
      view="plan"
      steps={[{ file: "src/a.ts", action: "create", reason: "" }]}
      currentPlanStep={0}
      planDeviated={false}
      width={60}
      diffResult={null}
      diffScrollOffset={0}
      diffVisibleRows={10}
    />,
  );
  const frame = lastFrame() ?? "";
  expect(frame).toContain("src/a.ts");
  expect(frame).toContain("create");
});

test("ContextPanel renders the empty diff view", () => {
  const { lastFrame } = render(
    <ContextPanel
      view="diff"
      steps={[]}
      currentPlanStep={null}
      planDeviated={false}
      width={40}
      diffResult={{ available: true, files: [] }}
      diffScrollOffset={0}
      diffVisibleRows={10}
    />,
  );
  expect(lastFrame()).toContain("No changes yet.");
});

test("ContextPanel renders diff lines with content", () => {
  const { lastFrame } = render(
    <ContextPanel
      view="diff"
      steps={[]}
      currentPlanStep={null}
      planDeviated={false}
      width={60}
      diffResult={{
        available: true,
        files: [
          {
            path: "src/a.ts",
            lines: [
              { kind: "hunk", text: "@@ -1 +1 @@" },
              { kind: "added", text: "+hello" },
            ],
          },
        ],
      }}
      diffScrollOffset={0}
      diffVisibleRows={10}
    />,
  );
  expect(lastFrame()).toContain("+hello");
});

test("ContextPanel shows a notice when git is unavailable", () => {
  const { lastFrame } = render(
    <ContextPanel
      view="diff"
      steps={[]}
      currentPlanStep={null}
      planDeviated={false}
      width={50}
      diffResult={{ available: false }}
      diffScrollOffset={0}
      diffVisibleRows={10}
    />,
  );
  expect(lastFrame()).toContain("Git unavailable");
});
