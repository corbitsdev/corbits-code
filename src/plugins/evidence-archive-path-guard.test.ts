import { describe, expect, test } from "bun:test";

import type { ToolCall, ToolResult } from "@intx/types/runtime";
import {
  evidenceArchivePathGuardPlugin,
  isProtectedEvidenceLocation,
} from "./evidence-archive-path-guard.js";

function makeCall(name: string, args: Record<string, unknown>): ToolCall {
  return { id: "test-call", name, arguments: args };
}

const nextHandler = async (call: ToolCall): Promise<ToolResult> => ({
  callId: call.id,
  content: "ok",
});

describe("isProtectedEvidenceLocation", () => {
  test("matches evidence-archive and tool-output/archive-* forms", () => {
    expect(isProtectedEvidenceLocation("evidence-archive/index.jsonl")).toBe(true);
    expect(isProtectedEvidenceLocation("/tmp/context/evidence-archive")).toBe(true);
    expect(isProtectedEvidenceLocation("C:\\tmp\\evidence-archive\\index.jsonl")).toBe(true);
    expect(isProtectedEvidenceLocation("tool-output/archive-sess-occ-1")).toBe(true);
    expect(isProtectedEvidenceLocation("tool-output:///archive-sess-occ-1")).toBe(true);
    expect(isProtectedEvidenceLocation("src/session/compaction-archive.ts")).toBe(false);
    expect(isProtectedEvidenceLocation("tool-output:///other-spill")).toBe(false);
  });
});

describe("evidenceArchivePathGuardPlugin", () => {
  test("denies path tools targeting evidence-archive or tool-output/archive-*", async () => {
    const plugin = evidenceArchivePathGuardPlugin();
    const handler = plugin.middleware ? plugin.middleware(nextHandler) : nextHandler;
    const denied = [
      makeCall("read_file", { path: "evidence-archive/index.jsonl" }),
      makeCall("grep", { path: "/tmp/context/evidence-archive", pattern: "foo" }),
      makeCall("search_files", { path: "evidence-archive" }),
      makeCall("list_dir", { path: "evidence-archive" }),
      makeCall("write_file", { path: "evidence-archive/x", content: "nope" }),
      makeCall("read_file", { path: "tool-output:///archive-sess-occ-1" }),
      makeCall("read_file", { path: "tool-output/archive-sess-occ-1" }),
    ];
    for (const call of denied) {
      const result = await handler(call, new AbortController().signal);
      expect(result.isError).toBe(true);
      expect(String(result.content)).toContain("search_archive");
      expect(String(result.content)).toContain("archive:///");
    }
  });

  test("does not deny a grep pattern that mentions evidence-archive", async () => {
    const plugin = evidenceArchivePathGuardPlugin();
    const handler = plugin.middleware ? plugin.middleware(nextHandler) : nextHandler;
    const result = await handler(
      makeCall("grep", { path: "src", pattern: "evidence-archive" }),
      new AbortController().signal,
    );
    expect(result.isError).not.toBe(true);
    expect(result.content).toBe("ok");
  });

  test("passes ordinary workspace paths", async () => {
    const plugin = evidenceArchivePathGuardPlugin();
    const handler = plugin.middleware ? plugin.middleware(nextHandler) : nextHandler;
    const result = await handler(
      makeCall("read_file", { path: "src/session/compaction-archive.ts" }),
      new AbortController().signal,
    );
    expect(result.isError).not.toBe(true);
    expect(result.content).toBe("ok");
  });
});
