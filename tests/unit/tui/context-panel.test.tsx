import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { ContextPanel } from "../../../src/tui/components/context-panel.js";

test("ContextPanel renders the plan view in plan mode", () => {
  const { lastFrame } = render(
    <ContextPanel
      view="plan"
      steps={[{ file: "src/a.ts", action: "create" }]}
      currentPlanStep={0}
      planDeviated={false}
      width={40}
    />,
  );
  expect(lastFrame()).toContain("src/a.ts — create");
});

test("ContextPanel stubs the diff view", () => {
  const { lastFrame } = render(
    <ContextPanel
      view="diff"
      steps={[]}
      currentPlanStep={null}
      planDeviated={false}
      width={40}
    />,
  );
  expect(lastFrame()).toContain("No changes yet.");
});
