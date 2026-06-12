import { describe, test, expect } from "bun:test";
import { reReadBlockPlugin } from "./re-read-block-plugin.js";
import type { CodingDirector } from "../agent/director.js";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

function makeDirectorStub(filesReadAtTurn: Map<string, number>): CodingDirector {
  return {
    getFilesReadAtTurn: () => filesReadAtTurn,
    getTurnsUsed: () => 0,
  } as unknown as CodingDirector;
}

function makeCall(name: string, path: string): ToolCall {
  return { id: "call-1", name, arguments: { path } } as unknown as ToolCall;
}

const passThrough = async (call: ToolCall): Promise<ToolResult> => ({
  callId: call.id,
  content: "file content",
});

describe("reReadBlockPlugin", () => {
  test("re-reading a file returns error with turn reference", async () => {
    const filesReadAtTurn = new Map([["src/foo.ts", 3]]);
    const plugin = reReadBlockPlugin(() => makeDirectorStub(filesReadAtTurn));
    const handler = plugin.middleware!(passThrough);

    const result = await handler(
      makeCall("read_file", "src/foo.ts"),
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/already read/i);
    expect(result.content).toMatch(/turn 3/);
  });

  test("first read of a file is allowed", async () => {
    const plugin = reReadBlockPlugin(() => makeDirectorStub(new Map()));
    const handler = plugin.middleware!(passThrough);

    const result = await handler(
      makeCall("read_file", "src/new.ts"),
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("file content");
  });

  test("reading 5 different files is not blocked", async () => {
    const filesReadAtTurn = new Map<string, number>();
    const plugin = reReadBlockPlugin(() => makeDirectorStub(filesReadAtTurn));
    const handler = plugin.middleware!(passThrough);

    for (let i = 1; i <= 5; i++) {
      const result = await handler(
        makeCall("read_file", `src/file${i}.ts`),
        new AbortController().signal,
      );
      expect(result.isError).toBeUndefined();
    }
  });

  test("write_file on a previously-read path is not blocked", async () => {
    const filesReadAtTurn = new Map([["src/foo.ts", 1]]);
    const plugin = reReadBlockPlugin(() => makeDirectorStub(filesReadAtTurn));
    const handler = plugin.middleware!(passThrough);

    const result = await handler(
      { id: "call-w", name: "write_file", arguments: { path: "src/foo.ts", content: "x" } } as unknown as ToolCall,
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
  });

  test("list_dir is not blocked", async () => {
    const filesReadAtTurn = new Map([["src/", 1]]);
    const plugin = reReadBlockPlugin(() => makeDirectorStub(filesReadAtTurn));
    const handler = plugin.middleware!(passThrough);

    const result = await handler(
      makeCall("list_dir", "src/"),
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
  });

  test("does not block when director is not yet available", async () => {
    const plugin = reReadBlockPlugin(() => undefined);
    const handler = plugin.middleware!(passThrough);

    const result = await handler(
      makeCall("read_file", "src/foo.ts"),
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
  });
});
