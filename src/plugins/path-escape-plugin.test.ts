import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pathEscapePlugin } from "./path-escape-plugin.js";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

function makeCall(name: string, args: Record<string, unknown>): ToolCall {
  return {
    id: "test-call",
    name,
    arguments: args,
  };
}

const nextHandler = async (call: ToolCall): Promise<ToolResult> => ({
  callId: call.id,
  content: "ok",
});

describe("pathEscapePlugin", () => {
  test("allows paths inside cwd", async () => {
    const plugin = pathEscapePlugin("/project");
    const handler = plugin.middleware
      ? plugin.middleware(nextHandler)
      : nextHandler;
    const result = await handler(
      makeCall("read_file", { path: "src/index.ts" }),
      new AbortController().signal,
    );
    expect(result.isError).not.toBe(true);
  });

  test("blocks paths that escape cwd", async () => {
    const plugin = pathEscapePlugin("/project");
    const handler = plugin.middleware
      ? plugin.middleware(nextHandler)
      : nextHandler;
    const result = await handler(
      makeCall("read_file", { path: "../secret.txt" }),
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/escapes working directory/);
  });

  test("blocks absolute paths outside cwd", async () => {
    const plugin = pathEscapePlugin("/project");
    const handler = plugin.middleware
      ? plugin.middleware(nextHandler)
      : nextHandler;
    const result = await handler(
      makeCall("read_file", { path: "/etc/passwd" }),
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/escapes working directory/);
  });

  test("allows cwd path itself", async () => {
    const plugin = pathEscapePlugin("/project");
    const handler = plugin.middleware
      ? plugin.middleware(nextHandler)
      : nextHandler;
    const result = await handler(
      makeCall("read_file", { path: "." }),
      new AbortController().signal,
    );
    expect(result.isError).not.toBe(true);
  });

  test("blocks escape via cwd key", async () => {
    const plugin = pathEscapePlugin("/project");
    const handler = plugin.middleware
      ? plugin.middleware(nextHandler)
      : nextHandler;
    const result = await handler(
      makeCall("run_shell", { cwd: "../secret" }),
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/escapes working directory/);
  });

  test("blocks escape via directory key", async () => {
    const plugin = pathEscapePlugin("/project");
    const handler = plugin.middleware
      ? plugin.middleware(nextHandler)
      : nextHandler;
    const result = await handler(
      makeCall("list_dir", { directory: "/etc" }),
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/escapes working directory/);
  });

  test("blocks escape via source key", async () => {
    const plugin = pathEscapePlugin("/project");
    const handler = plugin.middleware
      ? plugin.middleware(nextHandler)
      : nextHandler;
    const result = await handler(
      makeCall("copy", { source: "/etc/passwd" }),
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/escapes working directory/);
  });

  test("blocks escape via filename key", async () => {
    const plugin = pathEscapePlugin("/project");
    const handler = plugin.middleware
      ? plugin.middleware(nextHandler)
      : nextHandler;
    const result = await handler(
      makeCall("write_file", { filename: "../secret.txt" }),
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/escapes working directory/);
  });

  test("allowOutside passes outside paths through as absolute", async () => {
    const plugin = pathEscapePlugin("/project", () => [], { allowOutside: true });
    const next = async (call: ToolCall): Promise<ToolResult> => ({
      callId: call.id,
      content: JSON.stringify(call.arguments),
    });
    const handler = plugin.middleware ? plugin.middleware(next) : next;
    const result = await handler(
      makeCall("read_file", { path: "../other-repo/README.md" }),
      new AbortController().signal,
    );
    expect(result.isError).not.toBe(true);
    const args = JSON.parse(String(result.content)) as { path: string };
    expect(args.path).toBe("/other-repo/README.md");
  });

  test("allowOutside still leaves in-bounds paths absolute under cwd", async () => {
    const plugin = pathEscapePlugin("/project", () => [], { allowOutside: true });
    const next = async (call: ToolCall): Promise<ToolResult> => ({
      callId: call.id,
      content: JSON.stringify(call.arguments),
    });
    const handler = plugin.middleware ? plugin.middleware(next) : next;
    const result = await handler(
      makeCall("read_file", { path: "src/index.ts" }),
      new AbortController().signal,
    );
    expect(result.isError).not.toBe(true);
    const args = JSON.parse(String(result.content)) as { path: string };
    expect(args.path).toBe("/project/src/index.ts");
  });

  test("allowOutside getter is resolved per call", async () => {
    let allow = false;
    const plugin = pathEscapePlugin("/project", () => [], { allowOutside: () => allow });
    const next = async (call: ToolCall): Promise<ToolResult> => ({
      callId: call.id,
      content: JSON.stringify(call.arguments),
    });
    const handler = plugin.middleware ? plugin.middleware(next) : next;
    const blocked = await handler(
      makeCall("read_file", { path: "../other-repo/README.md" }),
      new AbortController().signal,
    );
    expect(blocked.isError).toBe(true);
    expect(blocked.content).toMatch(/escapes working directory/);

    allow = true;
    const allowed = await handler(
      makeCall("read_file", { path: "../other-repo/README.md" }),
      new AbortController().signal,
    );
    expect(allowed.isError).not.toBe(true);
    const args = JSON.parse(String(allowed.content)) as { path: string };
    expect(args.path).toBe("/other-repo/README.md");
  });

  describe("symlink TOCTOU (CL-6712)", () => {
    let cwd = "";

    beforeEach(async () => {
      cwd = await mkdtemp(join(tmpdir(), "corbits-path-escape-"));
    });

    afterEach(async () => {
      await rm(cwd, { recursive: true, force: true });
    });

    test("write_file receives the canonical path, unaffected by a later symlink retarget", async () => {
      const realTarget = join(cwd, "real-target");
      await mkdir(realTarget, { recursive: true });
      const link = join(cwd, "link");
      await symlink(realTarget, link);

      const plugin = pathEscapePlugin(cwd);
      const next = async (call: ToolCall): Promise<ToolResult> => ({
        callId: call.id,
        content: JSON.stringify(call.arguments),
      });
      const handler = plugin.middleware ? plugin.middleware(next) : next;

      const result = await handler(
        makeCall("write_file", { path: join("link", "note.txt"), content: "hi" }),
        new AbortController().signal,
      );
      const args = JSON.parse(String(result.content)) as { path: string };
      // The path handed to write_file is already the resolved real-target
      // location, not the symlink-relative path.
      expect(args.path).toBe(join(realpathSync(realTarget), "note.txt"));

      // An attacker retargets the symlink after the allow check. A writer
      // that (correctly) uses the path it was given above is unaffected —
      // it never re-traverses "link".
      const outside = await mkdtemp(join(tmpdir(), "corbits-path-escape-outside-"));
      await rm(link);
      await symlink(outside, link);
      expect(args.path).not.toContain(outside);

      // A real writer using the resolved path lands the bytes at the
      // canonical (safe) location, never under the retargeted symlink.
      await writeFile(args.path, "hi");
      expect(await readFile(args.path, "utf8")).toBe("hi");
      expect(existsSync(join(outside, "note.txt"))).toBe(false);

      await rm(outside, { recursive: true, force: true });
    });
  });
});
