import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { PlanView } from "../../../src/tui/components/plan-view.js";

test("PlanView renders all steps and a step count", () => {
  const { lastFrame } = render(
    <PlanView
      steps={[
        { file: "src/a.ts", action: "create" },
        { file: "src/b.ts", action: "edit" },
      ]}
      currentPlanStep={0}
      planDeviated={false}
      width={40}
    />,
  );
  const frame = lastFrame() ?? "";
  expect(frame).toContain("Plan");
  expect(frame).toContain("2 steps");
  expect(frame).toContain("src/a.ts — create");
  expect(frame).toContain("src/b.ts — edit");
});

test("PlanView marks the current step", () => {
  const { lastFrame } = render(
    <PlanView
      steps={[
        { file: "src/a.ts", action: "create" },
        { file: "src/b.ts", action: "edit" },
      ]}
      currentPlanStep={1}
      planDeviated={false}
      width={40}
    />,
  );
  expect(lastFrame()).toContain("▸");
});

test("PlanView shows an empty-plan message", () => {
  const { lastFrame } = render(
    <PlanView steps={[]} currentPlanStep={null} planDeviated={false} width={40} />,
  );
  expect(lastFrame()).toContain("No plan submitted yet.");
});
