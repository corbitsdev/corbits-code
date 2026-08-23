import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBlobReader } from "@intx/types/runtime";
import { createPosixTools, composeMiddleware } from "@intx/tools-posix";
import type { ToolPlugin } from "@intx/tools-posix";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import { createPermissionGate } from "../permission/gate.js";
import { buildCorePosixToolPlugins } from "./posix-tool-plugins.js";
import { createCompositeBlobReader, createLazyBlobReader } from "./lazy-blob-reader.js";
import { verifyPlugin } from "../plugins/verify-plugin.js";
import { editFileLineRangePlugin } from "../plugins/edit-file-line-range-plugin.js";

type ToolHandlerLike = (call: ToolCall, signal: AbortSignal) => Promise<ToolResult>;

/**
 * editFileLineRangePlugin never calls `next` for start_line/end_line edits (it
 * writes and returns directly), so verifyPlugin only observes those calls when
 * it sits earlier in the plugin array (composeMiddleware wraps outer-to-inner
 * in array order). Identify each plugin's middleware by a string unique to its
 * implementation rather than assuming array indices.
 */
function findMiddlewareIndex(
  plugins: ReturnType<typeof buildCorePosixToolPlugins>,
  marker: string,
): number {
  return plugins.findIndex((plugin) => plugin.middleware?.toString().includes(marker) === true);
}

describe("buildCorePosixToolPlugins", () => {
  test("applies permission gate and result truncation like the main agent stack", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ic-posix-plugins-"));
    try {
      const path = join(cwd, "big.txt");
      await writeFile(path, "x".repeat(90_000), "utf8");

      const gate = createPermissionGate({
        approvals: [],
        interactive: false,
        skipPermissions: false,
        auto: false,
        cwd,
      });
      const runner = createPosixTools({
        cwd,
        plugins: buildCorePosixToolPlugins({ cwd, permissionGate: gate }),
      });
      const outPath = join(cwd, "out.txt");
      const denied = await runner.run(
        { id: "1", name: "write_file", arguments: { path: outPath, content: "nope" } },
        new AbortController().signal,
      );
      expect(denied.isError).toBe(true);
      expect(String(denied.content)).toContain("Blocked by permission policy");

      const allowGate = createPermissionGate({
        approvals: [],
        interactive: false,
        skipPermissions: true,
        cwd,
      });
      const allowedRunner = createPosixTools({
        cwd,
        plugins: buildCorePosixToolPlugins({ cwd, permissionGate: allowGate }),
      });
      const allowed = await allowedRunner.run(
        { id: "2", name: "read_file", arguments: { path } },
        new AbortController().signal,
      );
      expect(allowed.isError).not.toBe(true);
      // The read-file guard caps the read before result-truncation would run,
      // so a 90KB single line comes back line-truncated and bounded.
      expect(String(allowed.content)).toContain("line truncated at 2000 chars");
      expect(Buffer.byteLength(String(allowed.content), "utf8")).toBeLessThan(4096);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("skipPermissions allows reading a path outside the workspace", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ic-posix-skip-in-"));
    const outside = await mkdtemp(join(tmpdir(), "ic-posix-skip-out-"));
    try {
      const target = join(outside, "other.txt");
      await writeFile(target, "from-other-repo", "utf8");
      const gate = createPermissionGate({
        approvals: [],
        interactive: false,
        skipPermissions: true,
        cwd,
      });
      const runner = createPosixTools({
        cwd,
        plugins: buildCorePosixToolPlugins({ cwd, permissionGate: gate }),
      });
      const result = await runner.run(
        { id: "out-1", name: "read_file", arguments: { path: target } },
        new AbortController().signal,
      );
      expect(result.isError).not.toBe(true);
      expect(String(result.content)).toContain("from-other-repo");
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("without skipPermissions, path-escape still blocks outside-workspace reads", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ic-posix-bound-in-"));
    const outside = await mkdtemp(join(tmpdir(), "ic-posix-bound-out-"));
    try {
      const target = join(outside, "secret.txt");
      await writeFile(target, "secret", "utf8");
      const gate = createPermissionGate({
        approvals: [],
        interactive: false,
        skipPermissions: false,
        auto: true,
        cwd,
      });
      const runner = createPosixTools({
        cwd,
        plugins: buildCorePosixToolPlugins({ cwd, permissionGate: gate }),
      });
      const result = await runner.run(
        { id: "bound-1", name: "read_file", arguments: { path: target } },
        new AbortController().signal,
      );
      expect(result.isError).toBe(true);
      expect(String(result.content)).toMatch(/escapes working directory/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("setSkipPermissions mid-session unlocks outside paths without rebuilding plugins", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ic-posix-yolo-toggle-in-"));
    const outside = await mkdtemp(join(tmpdir(), "ic-posix-yolo-toggle-out-"));
    try {
      const target = join(outside, "other.txt");
      await writeFile(target, "from-other-repo", "utf8");
      const gate = createPermissionGate({
        approvals: [],
        interactive: false,
        skipPermissions: false,
        auto: true,
        cwd,
      });
      const runner = createPosixTools({
        cwd,
        plugins: buildCorePosixToolPlugins({ cwd, permissionGate: gate }),
      });
      const blocked = await runner.run(
        { id: "bound-1", name: "read_file", arguments: { path: target } },
        new AbortController().signal,
      );
      expect(blocked.isError).toBe(true);
      expect(String(blocked.content)).toMatch(/escapes working directory/);

      gate.setSkipPermissions(true);
      const allowed = await runner.run(
        { id: "out-1", name: "read_file", arguments: { path: target } },
        new AbortController().signal,
      );
      expect(allowed.isError).not.toBe(true);
      expect(String(allowed.content)).toContain("from-other-repo");
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("reads bounded tool-output spills when session blob reader is wired", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ic-posix-tool-output-"));
    try {
      const encoder = new TextEncoder();
      const backing = createBlobReader({
        async readBlob(key: string) {
          if (key === "spill1") return encoder.encode("hello-spill");
          throw new Error(`missing ${key}`);
        },
      });
      const blobReader = createLazyBlobReader(() => backing);
      const gate = createPermissionGate({
        approvals: [],
        interactive: false,
        skipPermissions: true,
        cwd,
      });
      const runner = createPosixTools({
        cwd,
        blobReader,
        plugins: buildCorePosixToolPlugins({
          cwd,
          permissionGate: gate,
          readFileGuard: { blobReader },
        }),
      });
      const result = await runner.run(
        {
          id: "to1",
          name: "read_file",
          arguments: { path: "tool-output:///spill1" },
        },
        new AbortController().signal,
      );
      expect(result.isError).toBeFalsy();
      expect(String(result.content)).toContain("hello-spill");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("child composite blob reader re-reads parent tool-output URIs", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ic-posix-composite-blob-"));
    try {
      const encoder = new TextEncoder();
      // Mirrors runSubAgent wiring: child store bound after agent create, parent
      // always available so brief-handed tool-output:// URIs resolve (CL-4323).
      let childReader: ReturnType<typeof createBlobReader> | undefined;
      const parentReader = createBlobReader({
        async readBlob(key: string) {
          if (key === "parent-mcp-skill") return encoder.encode("parent-skill-body-tail");
          throw new Error(`Blob not found for key: ${JSON.stringify(key)}`);
        },
      });
      const blobReader = createCompositeBlobReader(
        () => childReader,
        () => parentReader,
      );
      const gate = createPermissionGate({
        approvals: [],
        interactive: false,
        skipPermissions: true,
        cwd,
      });
      const runner = createPosixTools({
        cwd,
        blobReader,
        plugins: buildCorePosixToolPlugins({
          cwd,
          permissionGate: gate,
          readFileGuard: { blobReader },
        }),
      });

      // Parent spill before child store is bound.
      const fromParent = await runner.run(
        {
          id: "p1",
          name: "read_file",
          arguments: { path: "tool-output:///parent-mcp-skill" },
        },
        new AbortController().signal,
      );
      expect(fromParent.isError).toBeFalsy();
      expect(String(fromParent.content)).toContain("parent-skill-body-tail");

      childReader = createBlobReader({
        async readBlob(key: string) {
          if (key === "child-local") return encoder.encode("child-own-spill");
          throw new Error(`Blob not found for key: ${JSON.stringify(key)}`);
        },
      });

      // Still falls through to parent after child is bound.
      const stillParent = await runner.run(
        {
          id: "p2",
          name: "read_file",
          arguments: { path: "tool-output:///parent-mcp-skill" },
        },
        new AbortController().signal,
      );
      expect(stillParent.isError).toBeFalsy();
      expect(String(stillParent.content)).toContain("parent-skill-body-tail");

      const fromChild = await runner.run(
        {
          id: "c1",
          name: "read_file",
          arguments: { path: "tool-output:///child-local" },
        },
        new AbortController().signal,
      );
      expect(fromChild.isError).toBeFalsy();
      expect(String(fromChild.content)).toContain("child-own-spill");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("verifyPlugin wraps editFileLineRangePlugin so line-range edits are still verified (CL-4405)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ic-posix-plugins-"));
    try {
      const gate = createPermissionGate({
        approvals: [],
        interactive: false,
        skipPermissions: true,
        cwd,
      });
      const plugins = buildCorePosixToolPlugins({ cwd, permissionGate: gate });

      const verifyIndex = findMiddlewareIndex(plugins, "Edit verification failed");
      const editRangeIndex = findMiddlewareIndex(plugins, "runEditFileLineRange");

      expect(verifyIndex).toBeGreaterThanOrEqual(0);
      expect(editRangeIndex).toBeGreaterThanOrEqual(0);
      expect(verifyIndex).toBeLessThan(editRangeIndex);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("a real line-range edit_file call verifies as success through the wired plugin chain", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ic-posix-plugins-"));
    try {
      const path = join(cwd, "test.txt");
      await writeFile(path, "a\nb\nc\n");

      const gate = createPermissionGate({
        approvals: [],
        interactive: false,
        skipPermissions: true,
        cwd,
      });
      const runner = createPosixTools({
        cwd,
        plugins: buildCorePosixToolPlugins({ cwd, permissionGate: gate }),
      });

      const result = await runner.run(
        {
          id: "call-1",
          name: "edit_file",
          arguments: { path, start_line: 2, end_line: 2, new_string: "B" },
        },
        new AbortController().signal,
      );

      expect(result.isError).not.toBe(true);
      const final = await readFile(path, "utf8");
      expect(final).toBe("a\nB\nc\n");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("verifyPlugin still catches a genuine line-range mismatch caused by a concurrent write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-posix-plugins-"));
    try {
      const path = join(dir, "test.txt");
      await writeFile(path, "a\nb\nc\n");

      // Stands in for another actor mutating the file between verifyPlugin's
      // before-snapshot and editFileLineRangePlugin's own read, so the edit
      // lands against a baseline verify never saw.
      const concurrentWriterMiddleware =
        (next: ToolHandlerLike): ToolHandlerLike =>
        async (call, signal) => {
          await writeFile(path, "z\ny\nx\n");
          return next(call, signal);
        };

      const base: ToolHandlerLike = async (call) => ({ callId: call.id, content: "unreachable" });
      const verifyMiddleware = verifyPlugin().middleware;
      const editRangeMiddleware = editFileLineRangePlugin().middleware;
      if (verifyMiddleware === undefined || editRangeMiddleware === undefined) {
        throw new Error("expected verifyPlugin and editFileLineRangePlugin to expose middleware");
      }
      const composed = composeMiddleware(
        [verifyMiddleware, concurrentWriterMiddleware, editRangeMiddleware],
        base,
      );

      const result = await composed(
        {
          id: "call-1",
          name: "edit_file",
          arguments: { path, start_line: 2, end_line: 2, new_string: "B" },
        },
        new AbortController().signal,
      );

      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/content mismatch after replacement/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a grep result containing a secret-shaped string is redacted before reaching the model (CL-5717)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ic-posix-grep-scrub-"));
    try {
      await writeFile(
        join(cwd, "leaky.env"),
        "AWS_KEY=AKIAABCDEFGHIJKLMNOP\nOPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456\n",
      );

      const gate = createPermissionGate({
        approvals: [],
        interactive: false,
        skipPermissions: true,
        cwd,
      });
      const runner = createPosixTools({
        cwd,
        plugins: buildCorePosixToolPlugins({ cwd, permissionGate: gate }),
      });

      const result = await runner.run(
        { id: "grep-1", name: "grep", arguments: { pattern: "AKIA|sk-", path: cwd } },
        new AbortController().signal,
      );

      expect(result.isError).not.toBe(true);
      const content = String(result.content);
      expect(content).not.toContain("AKIAABCDEFGHIJKLMNOP");
      expect(content).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
      expect(content).toContain("[redacted: looks like a credential]");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("a plugin that returns without calling next() still gets capped and scrubbed (CL-5717)", async () => {
    // Generic, plugin-shape-agnostic version of the grep case above: any
    // plugin that answers a scrubbable/truncatable tool directly instead of
    // delegating to `next` must still be capped and scrubbed, because it is
    // wrapped by the unconditional outer plugins in buildCorePosixToolPlugins.
    // This composes the REAL production array from the builder — not a
    // hand-picked middleware order — with a short-circuiting stand-in spliced
    // in at ripgrepPlugin's own position, so moving both terminal concerns
    // away from the front of the real array fails this test.
    //
    // This guards their PREPENDED POSITION only, not the RELATIVE order
    // between the two of them: the secret here sits at the very front of the
    // payload, nowhere near the cap boundary, so it survives even under the
    // exploitable cap-then-scrub order. The relative order is guarded solely
    // by the boundary-straddle test below — do not treat this test as
    // redundant with it.
    const secretShapedContent = `AKIAABCDEFGHIJKLMNOP\n${"x".repeat(90_000)}`;
    const shortCircuitingPlugin: ToolPlugin = {
      middleware:
        () =>
        async (call: ToolCall): Promise<ToolResult> => ({
          callId: call.id,
          content: secretShapedContent,
        }),
    };

    const gate = createPermissionGate({
      approvals: [],
      interactive: false,
      skipPermissions: true,
      cwd: "/tmp",
    });
    const plugins = buildCorePosixToolPlugins({ cwd: "/tmp", permissionGate: gate });
    const ripgrepIndex = findMiddlewareIndex(plugins, "no matches for /");
    expect(ripgrepIndex).toBeGreaterThanOrEqual(0);
    plugins[ripgrepIndex] = shortCircuitingPlugin;

    const composed = composeMiddleware(
      plugins
        .map((plugin) => plugin.middleware)
        .filter((mw): mw is NonNullable<typeof mw> => mw !== undefined),
      async (call) => ({
        callId: call.id,
        content: "unreachable: short-circuiting plugin never delegates",
      }),
    );

    const result = await composed(
      { id: "short-1", name: "grep", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).not.toBe(true);
    const content = String(result.content);
    expect(content).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(content).toContain("[redacted: looks like a credential]");
    expect(content.length).toBeLessThan(secretShapedContent.length);
    expect(content).toContain("[output truncated");
  });

  test("a secret straddling the character-cap boundary is still fully redacted, not left as a bare fragment (CL-5717)", async () => {
    // Regression guard for the exploitable ordering: if truncation ran before
    // the scrub, a secret split mid-pattern at the cap boundary would no
    // longer match the scrub's regex, and a bare, unredacted fragment of the
    // credential would reach the model with no redaction marker at all.
    const { MAX_RESULT_CHARS } = await import("../plugins/result-truncation-plugin.js");
    // A newline immediately ahead of the key gives the scrub regex's `\b` a
    // real word boundary; the padding length puts the cap boundary partway
    // through the 20-char key that follows, so a truncate-then-scrub bug
    // would cut the key down to an unmatchable, unredacted fragment.
    const padding = `${"x".repeat(MAX_RESULT_CHARS - 10)}\n`;
    const straddlingSecret = "AKIAABCDEFGHIJKLMNOP"; // 20 chars, cap lands mid-key
    const secretShapedContent = `${padding}${straddlingSecret}`;
    const shortCircuitingPlugin: ToolPlugin = {
      middleware:
        () =>
        async (call: ToolCall): Promise<ToolResult> => ({
          callId: call.id,
          content: secretShapedContent,
        }),
    };

    const gate = createPermissionGate({
      approvals: [],
      interactive: false,
      skipPermissions: true,
      cwd: "/tmp",
    });
    const plugins = buildCorePosixToolPlugins({ cwd: "/tmp", permissionGate: gate });
    const ripgrepIndex = findMiddlewareIndex(plugins, "no matches for /");
    expect(ripgrepIndex).toBeGreaterThanOrEqual(0);
    plugins[ripgrepIndex] = shortCircuitingPlugin;

    const composed = composeMiddleware(
      plugins
        .map((plugin) => plugin.middleware)
        .filter((mw): mw is NonNullable<typeof mw> => mw !== undefined),
      async (call) => ({
        callId: call.id,
        content: "unreachable: short-circuiting plugin never delegates",
      }),
    );

    const result = await composed(
      { id: "straddle-1", name: "grep", arguments: {} },
      new AbortController().signal,
    );

    // The redaction marker is longer than the key it replaces, so the cap can
    // still trim its tail — that's fine, it's already-redacted text. The
    // security property under test is narrower: no bare, matchable-or-partial
    // fragment of the raw key survives into the result.
    const content = String(result.content);
    expect(content).not.toContain(straddlingSecret);
    expect(content).not.toMatch(/AKIA[0-9A-Z]*/);
  });
});
