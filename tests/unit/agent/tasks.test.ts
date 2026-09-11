import { test, expect } from "bun:test";
import {
  applyManageTasks,
  createManageTasksRunner,
  hasActiveTasks,
  type Task,
} from "../../../src/agent/tasks.js";

test("applyManageTasks keeps tasks marked done so they can be shown checked off", () => {
  const current: Task[] = [
    { id: "t1", title: "One", status: "doing" },
    { id: "t2", title: "Two", status: "todo" },
  ];

  expect(
    applyManageTasks(current, {
      action: "update",
      updates: [{ id: "t1", status: "done" }],
    }),
  ).toEqual([
    { id: "t1", title: "One", status: "done" },
    { id: "t2", title: "Two", status: "todo" },
  ]);
});

test("applyManageTasks retains completed tasks from create calls", () => {
  expect(
    applyManageTasks([], {
      action: "create",
      tasks: [
        { id: "t1", title: "Done", status: "done" },
        { id: "t2", title: "Next" },
      ],
    }),
  ).toEqual([
    { id: "t1", title: "Done", status: "done" },
    { id: "t2", title: "Next", status: "todo" },
  ]);
});

test("applyManageTasks appends new ids on update when title is set", () => {
  const current: Task[] = [
    { id: "t1", title: "One", status: "done" },
    { id: "t2", title: "Two", status: "doing" },
  ];
  expect(
    applyManageTasks(current, {
      action: "update",
      updates: [
        { id: "t2", status: "done" },
        { id: "t3", title: "Discovered follow-up", status: "todo" },
      ],
    }),
  ).toEqual([
    { id: "t1", title: "One", status: "done" },
    { id: "t2", title: "Two", status: "done" },
    { id: "t3", title: "Discovered follow-up", status: "todo" },
  ]);
});

test("applyManageTasks ignores unknown id without title (no accidental empty append)", () => {
  const current: Task[] = [{ id: "t1", title: "One", status: "todo" }];
  expect(
    applyManageTasks(current, {
      action: "update",
      updates: [{ id: "t-missing", status: "done" }],
    }),
  ).toEqual(current);
});

test("applyManageTasks create replaces the list for a full replan", () => {
  const current: Task[] = [
    { id: "t1", title: "Old", status: "doing" },
    { id: "t2", title: "Drop me", status: "todo" },
  ];
  expect(
    applyManageTasks(current, {
      action: "create",
      tasks: [
        { id: "t1", title: "Old (kept)", status: "done" },
        { id: "t3", title: "New path" },
      ],
    }),
  ).toEqual([
    { id: "t1", title: "Old (kept)", status: "done" },
    { id: "t3", title: "New path", status: "todo" },
  ]);
});

test("hasActiveTasks is true while any task is todo or doing", () => {
  expect(hasActiveTasks([{ id: "t1", title: "One", status: "doing" }])).toBe(
    true,
  );
  expect(
    hasActiveTasks([
      { id: "t1", title: "One", status: "done" },
      { id: "t2", title: "Two", status: "todo" },
    ]),
  ).toBe(true);
});

test("hasActiveTasks is false for an empty or all-terminal list", () => {
  expect(hasActiveTasks([])).toBe(false);
  expect(
    hasActiveTasks([
      { id: "t1", title: "One", status: "done" },
      { id: "t2", title: "Two", status: "cancelled" },
    ]),
  ).toBe(false);
});

test("manage_tasks runner reports a repeat update that changes nothing", async () => {
  const run = createManageTasksRunner();
  await run({
    action: "create",
    tasks: [{ id: "t8", title: "Ship it", status: "doing" }],
  });
  const again = await run({
    action: "update",
    updates: [{ id: "t8", status: "doing" }],
  });
  expect(again.content).toBe("No change: t8 already doing.");
});

test("manage_tasks runner reports a repeat create that changes nothing", async () => {
  const run = createManageTasksRunner();
  const args = { action: "create", tasks: [{ id: "t1", title: "One" }] };
  expect((await run(args)).content).toBe("Tasks updated.");
  expect((await run(args)).content).toBe(
    "No change: task list already matches.",
  );
});

test("manage_tasks runner still reports real updates as updated", async () => {
  const run = createManageTasksRunner();
  await run({
    action: "create",
    tasks: [{ id: "t1", title: "One", status: "doing" }],
  });
  expect(
    (await run({ action: "update", updates: [{ id: "t1", status: "done" }] }))
      .content,
  ).toBe("Tasks updated.");
});

test("manage_tasks runner reports updates against unknown or empty input", async () => {
  const run = createManageTasksRunner();
  expect((await run({ action: "update" })).content).toBe(
    "No change: no updates supplied.",
  );
  expect(
    (await run({ action: "update", updates: [{ id: "t9" }] })).content,
  ).toBe("No change: t9 not found.");
});

test("manage_tasks runner rejects invalid args", async () => {
  const run = createManageTasksRunner();
  const result = await run({});
  expect(result.isError).toBe(true);
});
