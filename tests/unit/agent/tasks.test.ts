import { test, expect } from "bun:test";
import { applyManageTasks, type Task } from "../../../src/agent/tasks.js";

test("applyManageTasks removes tasks when they are marked done", () => {
  const current: Task[] = [
    { id: "t1", title: "One", status: "doing" },
    { id: "t2", title: "Two", status: "todo" },
  ];

  expect(applyManageTasks(current, { action: "update", updates: [{ id: "t1", status: "done" }] })).toEqual([
    { id: "t2", title: "Two", status: "todo" },
  ]);
});

test("applyManageTasks does not keep completed tasks from create calls", () => {
  expect(applyManageTasks([], {
    action: "create",
    tasks: [
      { id: "t1", title: "Done", status: "done" },
      { id: "t2", title: "Next" },
    ],
  })).toEqual([
    { id: "t2", title: "Next", status: "todo" },
  ]);
});
