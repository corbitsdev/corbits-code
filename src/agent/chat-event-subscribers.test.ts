import { describe, expect, test } from "bun:test";
import {
  CHAT_TASKS_CHANGED_EVENT,
  CHAT_TOOLS_ACTIVATE_EVENT,
} from "./director.js";
import { handleChatDirectorEvent } from "./chat-event-subscribers.js";
import type { Task } from "./tasks.js";

function makeLog() {
  const calls: { message: string; fields?: Record<string, unknown> }[] = [];
  return {
    calls,
    log: (message: string, fields?: Record<string, unknown>): void => {
      calls.push(fields !== undefined ? { message, fields } : { message });
    },
  };
}

describe("handleChatDirectorEvent", () => {
  test("dispatches a valid tasks-changed payload without logging", () => {
    const seen: Task[][] = [];
    const log = makeLog();
    const handled = handleChatDirectorEvent(
      {
        type: CHAT_TASKS_CHANGED_EVENT,
        data: { tasks: [{ id: "t1", title: "work", status: "doing" }] },
      },
      {
        onTasksChanged: (tasks) => seen.push(tasks),
        onToolsActivate: () => {
          throw new Error("unexpected tools-activate dispatch");
        },
      },
      log.log,
    );
    expect(handled).toBe(true);
    expect(seen).toEqual([[{ id: "t1", title: "work", status: "doing" }]]);
    expect(log.calls).toEqual([]);
  });

  test("dispatches a valid tools-activate payload without logging", () => {
    const seen: string[][] = [];
    const log = makeLog();
    const handled = handleChatDirectorEvent(
      { type: CHAT_TOOLS_ACTIVATE_EVENT, data: { names: ["lsp"] } },
      {
        onTasksChanged: () => {
          throw new Error("unexpected tasks-changed dispatch");
        },
        onToolsActivate: (names) => seen.push([...names]),
      },
      log.log,
    );
    expect(handled).toBe(true);
    expect(seen).toEqual([["lsp"]]);
    expect(log.calls).toEqual([]);
  });

  test("drops an invalid tasks payload with a debug log naming the failure", () => {
    let dispatched = false;
    const log = makeLog();
    const handled = handleChatDirectorEvent(
      { type: CHAT_TASKS_CHANGED_EVENT, data: { tasks: "not-a-list" } },
      {
        onTasksChanged: () => {
          dispatched = true;
        },
        onToolsActivate: () => {
          dispatched = true;
        },
      },
      log.log,
    );
    expect(handled).toBe(true);
    expect(dispatched).toBe(false);
    expect(log.calls).toHaveLength(1);
    expect(log.calls[0]?.message).toMatch(/tasks-changed/);
    expect(typeof log.calls[0]?.fields?.["error"]).toBe("string");
  });

  test("drops an invalid tools payload with a debug log naming the failure", () => {
    let dispatched = false;
    const log = makeLog();
    const handled = handleChatDirectorEvent(
      { type: CHAT_TOOLS_ACTIVATE_EVENT, data: { names: [42] } },
      {
        onTasksChanged: () => {
          dispatched = true;
        },
        onToolsActivate: () => {
          dispatched = true;
        },
      },
      log.log,
    );
    expect(handled).toBe(true);
    expect(dispatched).toBe(false);
    expect(log.calls).toHaveLength(1);
    expect(log.calls[0]?.message).toMatch(/tools-activate/);
    expect(typeof log.calls[0]?.fields?.["error"]).toBe("string");
  });

  test("ignores unrelated events without logging or dispatching", () => {
    let dispatched = false;
    const log = makeLog();
    const handled = handleChatDirectorEvent(
      { type: "inference.done", data: {} },
      {
        onTasksChanged: () => {
          dispatched = true;
        },
        onToolsActivate: () => {
          dispatched = true;
        },
      },
      log.log,
    );
    expect(handled).toBe(false);
    expect(dispatched).toBe(false);
    expect(log.calls).toEqual([]);
  });
});
