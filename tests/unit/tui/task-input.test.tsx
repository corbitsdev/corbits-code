import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { TaskInput } from "../../../src/tui/components/task-input.js";

test("TaskInput renders prompt", () => {
  const { lastFrame } = render(<TaskInput onSubmit={() => {}} />);
  expect(lastFrame()).toContain("Enter a task description");
  expect(lastFrame()).toContain("> ");
});
