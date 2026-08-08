import { describe, test, expect } from "bun:test";
import type { ConversationTurn } from "@intx/types/runtime";
import { turnsToContentBlocks } from "./turns-to-blocks.js";
import { hydrateTasksFromTurns } from "../agent/director.js";

function manageTasksTurn(id: string, status: "todo" | "doing" | "done"): ConversationTurn {
  return {
    role: "assistant",
    model: "test",
    timestamp: 0,
    content: [
      {
        type: "tool_call",
        id,
        name: "manage_tasks",
        arguments: { action: "create", tasks: [{ id: "t1", title: "work", status }] },
      },
    ],
  } as unknown as ConversationTurn;
}

function toolResultTurn(callId: string, isError: boolean): ConversationTurn {
  return {
    role: "assistant",
    model: "test",
    timestamp: 0,
    content: [{ type: "tool_result", callId, content: "ok", isError }],
  } as unknown as ConversationTurn;
}

describe("turnsToContentBlocks no longer derives tasks", () => {
  test("a transcript with manage_tasks calls produces no tasks block on its own", () => {
    const turns = [manageTasksTurn("m1", "doing"), toolResultTurn("m1", false)];
    const blocks = turnsToContentBlocks(turns);
    expect(blocks.some((b) => b.type === "tasks")).toBe(false);
  });

  // The aggregated task block is unshifted separately on resume, so leaving
  // the raw rows in would show every manage_tasks call twice over.
  test("manage_tasks call and result rows are stripped from the resumed transcript", () => {
    const turns = [
      manageTasksTurn("m1", "todo"),
      toolResultTurn("m1", false),
      manageTasksTurn("m2", "doing"),
      toolResultTurn("m2", false),
    ];
    const blocks = turnsToContentBlocks(turns);
    expect(blocks.some((b) => b.type === "tool_call" && b.name === "manage_tasks")).toBe(false);
    expect(blocks.some((b) => b.type === "tool_result" && b.name === "manage_tasks")).toBe(false);
  });

  // hydrateTasksFromTurns applies manage_tasks on the tool_call regardless of
  // the result's outcome, so the strip must match: an errored or missing
  // result must not leave the raw call/result rows behind next to the
  // aggregated block runner.ts unshifts from hydrateTasksFromTurns.
  test("strips a manage_tasks call whose result errored", () => {
    const turns = [manageTasksTurn("m1", "doing"), toolResultTurn("m1", true)];
    const blocks = turnsToContentBlocks(turns);
    expect(blocks.some((b) => b.type === "tool_call" && b.name === "manage_tasks")).toBe(false);
    expect(blocks.some((b) => b.type === "tool_result" && b.name === "manage_tasks")).toBe(false);
  });

  test("strips a manage_tasks call with no result at all (interrupted turn)", () => {
    const turns = [manageTasksTurn("m1", "doing")];
    const blocks = turnsToContentBlocks(turns);
    expect(blocks.some((b) => b.type === "tool_call" && b.name === "manage_tasks")).toBe(false);
  });
});

describe("hydrateTasksFromTurns", () => {
  test("derives the task list from manage_tasks tool calls in a transcript", () => {
    const turns = [manageTasksTurn("m1", "doing"), toolResultTurn("m1", false)];
    const tasks = hydrateTasksFromTurns(turns);
    expect(tasks).toEqual([{ id: "t1", title: "work", status: "doing" }]);
  });

  test("applies a manage_tasks call even when its tool_result later errors, matching live decide() behavior", () => {
    const turns = [manageTasksTurn("m1", "doing"), toolResultTurn("m1", true)];
    const tasks = hydrateTasksFromTurns(turns);
    expect(tasks).toEqual([{ id: "t1", title: "work", status: "doing" }]);
  });

  test("returns an empty list for a transcript with no manage_tasks calls", () => {
    const turns: ConversationTurn[] = [
      { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 } as unknown as ConversationTurn,
    ];
    expect(hydrateTasksFromTurns(turns)).toEqual([]);
  });
});

describe("resume rendering, end to end (mirrors runner.ts's hydrate composition)", () => {
  test("a manage_tasks call whose result errored shows the task exactly once", () => {
    const turns = [manageTasksTurn("m1", "doing"), toolResultTurn("m1", true)];

    const blocks = turnsToContentBlocks(turns);
    const tasks = hydrateTasksFromTurns(turns);
    if (tasks.length > 0) blocks.unshift({ type: "tasks", tasks });

    const taskBlocks = blocks.filter((b) => b.type === "tasks");
    expect(taskBlocks).toHaveLength(1);
    expect(taskBlocks[0]).toEqual({ type: "tasks", tasks: [{ id: "t1", title: "work", status: "doing" }] });
    expect(blocks.some((b) => b.type === "tool_call" && b.name === "manage_tasks")).toBe(false);
  });

  test("a manage_tasks call with no result at all shows the task exactly once", () => {
    const turns = [manageTasksTurn("m1", "doing")];

    const blocks = turnsToContentBlocks(turns);
    const tasks = hydrateTasksFromTurns(turns);
    if (tasks.length > 0) blocks.unshift({ type: "tasks", tasks });

    const taskBlocks = blocks.filter((b) => b.type === "tasks");
    expect(taskBlocks).toHaveLength(1);
    expect(blocks.some((b) => b.type === "tool_call" && b.name === "manage_tasks")).toBe(false);
  });
});
