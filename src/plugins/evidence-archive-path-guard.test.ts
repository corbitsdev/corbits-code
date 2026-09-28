import { describe, expect, test } from "bun:test";

import {
  evidenceArchivePathGuardPlugin,
  isProtectedEvidenceLocation,
} from "./evidence-archive-path-guard.js";
import {
  makeToolCall,
  neverAbort,
  okHandler,
  pluginHandler,
} from "./test-helpers.js";

describe("isProtectedEvidenceLocation", () => {
  test("matches evidence-archive and tool-output/archive-* forms", () => {
    expect(isProtectedEvidenceLocation("evidence-archive/index.jsonl")).toBe(
      true,
    );
    expect(isProtectedEvidenceLocation("/tmp/context/evidence-archive")).toBe(
      true,
    );
    expect(
      isProtectedEvidenceLocation("C:\\tmp\\evidence-archive\\index.jsonl"),
    ).toBe(true);
    expect(isProtectedEvidenceLocation("tool-output/archive-sess-occ-1")).toBe(
      true,
    );
    expect(
      isProtectedEvidenceLocation("tool-output:///archive-sess-occ-1"),
    ).toBe(true);
    expect(
      isProtectedEvidenceLocation("src/session/compaction-archive.ts"),
    ).toBe(false);
    expect(isProtectedEvidenceLocation("tool-output:///other-spill")).toBe(
      false,
    );
  });
});

describe("evidenceArchivePathGuardPlugin", () => {
  test("denies path tools targeting evidence-archive or tool-output/archive-*", async () => {
    const plugin = evidenceArchivePathGuardPlugin();
    const handler = pluginHandler(plugin, okHandler);
    const denied = [
      makeToolCall("read_file", { path: "evidence-archive/index.jsonl" }),
      makeToolCall("grep", {
        path: "/tmp/context/evidence-archive",
        pattern: "foo",
      }),
      makeToolCall("search_files", { path: "evidence-archive" }),
      makeToolCall("list_dir", { path: "evidence-archive" }),
      makeToolCall("write_file", {
        path: "evidence-archive/x",
        content: "nope",
      }),
      makeToolCall("read_file", { path: "tool-output:///archive-sess-occ-1" }),
      makeToolCall("read_file", { path: "tool-output/archive-sess-occ-1" }),
    ];
    for (const call of denied) {
      const result = await handler(call, neverAbort());
      expect(result.isError).toBe(true);
      expect(String(result.content)).toContain("search_files");
      expect(String(result.content)).toContain("archive:///");
    }
  });

  test("does not deny a grep pattern that mentions evidence-archive", async () => {
    const plugin = evidenceArchivePathGuardPlugin();
    const handler = pluginHandler(plugin, okHandler);
    const result = await handler(
      makeToolCall("grep", { path: "src", pattern: "evidence-archive" }),
      neverAbort(),
    );
    expect(result.isError).not.toBe(true);
    expect(result.content).toBe("ok");
  });

  test("passes ordinary workspace paths", async () => {
    const plugin = evidenceArchivePathGuardPlugin();
    const handler = pluginHandler(plugin, okHandler);
    const result = await handler(
      makeToolCall("read_file", { path: "src/session/compaction-archive.ts" }),
      neverAbort(),
    );
    expect(result.isError).not.toBe(true);
    expect(result.content).toBe("ok");
  });
});
