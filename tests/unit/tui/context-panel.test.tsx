import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { ContextPanel } from "../../../src/tui/components/context-panel.js";

test("ContextPanel renders the task view", () => {
  const { lastFrame } = render(
    <ContextPanel
      tasks={[{ id: "1", title: "Create src/a.ts", status: "todo" }]}
      width={60}
    />,
  );
  const frame = lastFrame() ?? "";
  expect(frame).toContain("Create src/a.ts");
});
