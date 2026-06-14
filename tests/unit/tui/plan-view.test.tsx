import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { PlanView } from "../../../src/tui/components/plan-view.js";

test("PlanView renders all steps and a step count", () => {
  const { lastFrame } = render(
    <PlanView
      steps={[
        { file: "src/a.ts", action: "create", reason: "needed" },
        { file: "src/b.ts", action: "edit", reason: "needed" },
      ]}
      currentPlanStep={0}
      planDeviated={false}
      width={60}
    />,
  );
  const frame = lastFrame() ?? "";
  expect(frame).toContain("Plan");
  expect(frame).toContain("src/a.ts");
  expect(frame).toContain("create");
  expect(frame).toContain("src/b.ts");
});

test("PlanView marks the current step", () => {
  const { lastFrame } = render(
    <PlanView
      steps={[
        { file: "src/a.ts", action: "create", reason: "needed" },
        { file: "src/b.ts", action: "edit", reason: "needed" },
      ]}
      currentPlanStep={1}
      planDeviated={false}
      width={60}
    />,
  );
  expect(lastFrame()).toContain("▸");
});

test("PlanView shows an empty-plan message", () => {
  const { lastFrame } = render(
    <PlanView steps={[]} currentPlanStep={null} planDeviated={false} width={40} />,
  );
  expect(lastFrame()).toContain("Waiting for agent");
});

test("PlanView shows goal when provided", () => {
  const { lastFrame } = render(
    <PlanView
      goal="Add tests for the auth module"
      steps={[{ file: "tests/auth.test.ts", action: "create", reason: "coverage" }]}
      currentPlanStep={0}
      planDeviated={false}
      width={60}
    />,
  );
  expect(lastFrame()).toContain("Add tests for the auth module");
});
