import { test, expect } from "bun:test";
import { applyManageTasks, hasActiveTasks, type Task } from "../../../src/agent/tasks.js";

test("applyManageTasks keeps tasks marked done so they can be shown checked off", () => {
  const current: Task[] = [
    { id: "t1", title: "One", status: "doing" },
    { id: "t2", title: "Two", status: "todo" },
  ];

  expect(applyManageTasks(current, { action: "update", updates: [{ id: "t1", status: "done" }] })).toEqual([
    { id: "t1", title: "One", status: "done" },
    { id: "t2", title: "Two", status: "todo" },
  ]);
});

test("applyManageTasks retains completed tasks from create calls", () => {
  expect(applyManageTasks([], {
    action: "create",
    tasks: [
      { id: "t1", title: "Done", status: "done" },
      { id: "t2", title: "Next" },
    ],
  })).toEqual([
    { id: "t1", title: "Done", status: "done" },
    { id: "t2", title: "Next", status: "todo" },
  ]);
});

test("hasActiveTasks is true while any task is todo or doing", () => {
  expect(hasActiveTasks([{ id: "t1", title: "One", status: "doing" }])).toBe(true);
  expect(hasActiveTasks([
    { id: "t1", title: "One", status: "done" },
    { id: "t2", title: "Two", status: "todo" },
  ])).toBe(true);
});

test("hasActiveTasks is false for an empty or all-terminal list", () => {
  expect(hasActiveTasks([])).toBe(false);
  expect(hasActiveTasks([
    { id: "t1", title: "One", status: "done" },
    { id: "t2", title: "Two", status: "cancelled" },
  ])).toBe(false);
});
