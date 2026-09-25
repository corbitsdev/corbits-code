import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  normalizePathArguments,
  pathEscapeBlockReason,
  pathEscapePlugin,
} from "./path-escape-plugin.js";
import {
  encodeResumeCursor,
  type ResumeCursor,
} from "../util/tool-output-uri.js";
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

  for (const [key, tool, value] of [
    ["path", "read_file", "../secret.txt"],
    ["path", "read_file", "/etc/passwd"],
    ["cwd", "run_shell", "../secret"],
    ["directory", "list_dir", "/etc"],
    ["source", "copy", "/etc/passwd"],
    ["filename", "write_file", "../secret.txt"],
  ] as const) {
    test(`blocks escape via ${key} key (${tool})`, async () => {
      const plugin = pathEscapePlugin("/project");
      const handler = plugin.middleware
        ? plugin.middleware(nextHandler)
        : nextHandler;
      const result = await handler(
        makeCall(tool, { [key]: value }),
        new AbortController().signal,
      );
      expect(result.isError).toBe(true);
    });
  }

  test("the block message tells the operator the path escapes the working directory", async () => {
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

  test("allowOutside passes outside paths through as absolute", async () => {
    const plugin = pathEscapePlugin("/project", () => [], {
      allowOutside: true,
    });
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
    const plugin = pathEscapePlugin("/project", () => [], {
      allowOutside: true,
    });
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
    const plugin = pathEscapePlugin("/project", () => [], {
      allowOutside: () => allow,
    });
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

  test("passes archive:/// refs through without resolving them as filesystem paths", async () => {
    const plugin = pathEscapePlugin("/project");
    const next = async (call: ToolCall): Promise<ToolResult> => ({
      callId: call.id,
      content: JSON.stringify(call.arguments),
    });
    const handler = plugin.middleware ? plugin.middleware(next) : next;
    const result = await handler(
      makeCall("read_file", { path: "archive:///occ-abc" }),
      new AbortController().signal,
    );
    expect(result.isError).not.toBe(true);
    const args = JSON.parse(String(result.content)) as { path: string };
    expect(args.path).toBe("archive:///occ-abc");
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
        makeCall("write_file", {
          path: join("link", "note.txt"),
          content: "hi",
        }),
        new AbortController().signal,
      );
      const args = JSON.parse(String(result.content)) as { path: string };
      // The path handed to write_file is already the resolved real-target
      // location, not the symlink-relative path.
      expect(args.path).toBe(join(realpathSync(realTarget), "note.txt"));

      // An attacker retargets the symlink after the allow check. A writer
      // that (correctly) uses the path it was given above is unaffected —
      // it never re-traverses "link".
      const outside = await mkdtemp(
        join(tmpdir(), "corbits-path-escape-outside-"),
      );
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

  describe("nested and alternate path keys (CL-6730)", () => {
    const captureNext = () => {
      let seen: Record<string, unknown> = {};
      const next = async (call: ToolCall): Promise<ToolResult> => {
        seen = call.arguments as Record<string, unknown>;
        return {
          callId: call.id,
          content: JSON.stringify(call.arguments),
        };
      };
      return { next, seen: () => seen };
    };

    test("blocks escape in a nested object under a path-like key", async () => {
      const plugin = pathEscapePlugin("/project");
      const handler = plugin.middleware
        ? plugin.middleware(nextHandler)
        : nextHandler;
      const result = await handler(
        makeCall("read_file", { options: { path: "../secret.txt" } }),
        new AbortController().signal,
      );
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/escapes working directory/);
    });

    test("resolves nested in-bounds paths instead of passing them through", async () => {
      const plugin = pathEscapePlugin("/project");
      const { next, seen } = captureNext();
      const handler = plugin.middleware ? plugin.middleware(next) : next;
      const result = await handler(
        makeCall("read_file", { options: { path: "src/index.ts" } }),
        new AbortController().signal,
      );
      expect(result.isError).not.toBe(true);
      expect(seen()).toEqual({
        options: { path: "/project/src/index.ts" },
      });
    });

    test("blocks escape via the filepath spelling", async () => {
      const plugin = pathEscapePlugin("/project");
      const handler = plugin.middleware
        ? plugin.middleware(nextHandler)
        : nextHandler;
      const result = await handler(
        makeCall("read_file", { filepath: "../secret.txt" }),
        new AbortController().signal,
      );
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/escapes working directory/);
    });

    test("blocks escape in a string array under a path-like key", async () => {
      const plugin = pathEscapePlugin("/project");
      const handler = plugin.middleware
        ? plugin.middleware(nextHandler)
        : nextHandler;
      const result = await handler(
        makeCall("read_file", {
          paths: ["src/index.ts", "../secret.txt"],
        }),
        new AbortController().signal,
      );
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/escapes working directory/);
    });

    test("pathEscapeBlockReason agrees with execution time on nested escapes", async () => {
      expect(
        pathEscapeBlockReason(
          { options: { path: "../secret.txt" } },
          "/project",
          () => [],
          "read_file",
        ),
      ).toMatch(/escapes working directory/);
      expect(
        pathEscapeBlockReason(
          { filepath: "../secret.txt" },
          "/project",
          () => [],
          "read_file",
        ),
      ).toMatch(/escapes working directory/);
      expect(
        pathEscapeBlockReason(
          { paths: ["src/index.ts", "../secret.txt"] },
          "/project",
          () => [],
          "read_file",
        ),
      ).toMatch(/escapes working directory/);
    });

    test("nested non-path keys pass through untouched (allowlist policy)", async () => {
      const plugin = pathEscapePlugin("/project");
      const { next, seen } = captureNext();
      const handler = plugin.middleware ? plugin.middleware(next) : next;
      const result = await handler(
        makeCall("custom_tool", { options: { command: "../secret.txt" } }),
        new AbortController().signal,
      );
      expect(result.isError).not.toBe(true);
      expect(seen()).toEqual({ options: { command: "../secret.txt" } });
      expect(
        pathEscapeBlockReason(
          { options: { command: "../secret.txt" } },
          "/project",
          () => [],
          "custom_tool",
        ),
      ).toBeUndefined();
    });

    test("FILE_PATH and file-path match case- and separator-insensitively", async () => {
      const plugin = pathEscapePlugin("/project");
      const handler = plugin.middleware
        ? plugin.middleware(nextHandler)
        : nextHandler;
      for (const key of ["FILE_PATH", "file-path"]) {
        const result = await handler(
          makeCall("read_file", { [key]: "../secret.txt" }),
          new AbortController().signal,
        );
        expect(result.isError).toBe(true);
        expect(result.content).toMatch(/escapes working directory/);
        expect(
          pathEscapeBlockReason(
            { [key]: "../secret.txt" },
            "/project",
            () => [],
            "read_file",
          ),
        ).toMatch(/escapes working directory/);
      }
    });

    test("xpath, jsonpath, and classpath keys pass through untouched", async () => {
      const plugin = pathEscapePlugin("/project");
      const { next, seen } = captureNext();
      const handler = plugin.middleware ? plugin.middleware(next) : next;
      const args = {
        xpath: "../../title",
        jsonpath: "$.store.book",
        classpath: "src/Main",
      };
      const result = await handler(
        makeCall("custom_tool", args),
        new AbortController().signal,
      );
      expect(result.isError).not.toBe(true);
      expect(seen()).toEqual(args);
      expect(
        pathEscapeBlockReason(args, "/project", () => [], "custom_tool"),
      ).toBeUndefined();
    });

    test("normalizePathArguments shares the plugin rewrite identity", () => {
      expect(
        normalizePathArguments(
          { options: { path: "src/index.ts" } },
          "/project",
          () => [],
        ),
      ).toEqual({ options: { path: "/project/src/index.ts" } });
      expect(
        normalizePathArguments(
          { options: { command: "../secret.txt" } },
          "/project",
          () => [],
        ),
      ).toEqual({ options: { command: "../secret.txt" } });
      expect(
        normalizePathArguments({ xpath: "src/index.ts" }, "/project", () => []),
      ).toEqual({ xpath: "src/index.ts" });
    });
  });

  describe("spill URI sandbox (CL-6727)", () => {
    test("pathEscapeBlockReason blocks a tool-output URI for a non-reader", () => {
      const reason = pathEscapeBlockReason(
        { path: "tool-output:///abc123" },
        "/project",
        () => [],
        "grep",
      );
      expect(reason).toMatch(/tool-output/);
    });

    test("middleware blocks a non-reader tool-output call with no rejector plugin", async () => {
      const plugin = pathEscapePlugin("/project");
      const handler = plugin.middleware
        ? plugin.middleware(nextHandler)
        : nextHandler;
      const result = await handler(
        makeCall("grep", {
          pattern: "foo",
          path: "tool-output:///abc123",
        }),
        new AbortController().signal,
      );
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/tool-output/);
    });

    test("read_file still passes a tool-output URI through", async () => {
      expect(
        pathEscapeBlockReason(
          { path: "tool-output:///abc123" },
          "/project",
          () => [],
          "read_file",
        ),
      ).toBeUndefined();
      const plugin = pathEscapePlugin("/project");
      const next = async (call: ToolCall): Promise<ToolResult> => ({
        callId: call.id,
        content: JSON.stringify(call.arguments),
      });
      const handler = plugin.middleware ? plugin.middleware(next) : next;
      const result = await handler(
        makeCall("read_file", { path: "tool-output:///abc123" }),
        new AbortController().signal,
      );
      expect(result.isError).not.toBe(true);
      const args = JSON.parse(String(result.content)) as { path: string };
      expect(args.path).toBe("tool-output:///abc123");
    });

    test("a forged file cursor for an outside-root path is denied, not served", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "corbits-escape-cursor-cwd-"));
      const outsideDir = await mkdtemp(
        join(tmpdir(), "corbits-escape-cursor-outside-"),
      );
      const outsidePath = join(outsideDir, "secret.txt");
      await writeFile(outsidePath, "top-secret");
      try {
        const forged = encodeResumeCursor({
          source: { kind: "file", path: outsidePath },
          offset: 0,
          limit: 4,
          nonce: "forged-nonce",
        } satisfies ResumeCursor);
        expect(
          pathEscapeBlockReason({ path: forged }, cwd, () => [], "read_file"),
        ).toMatch(/escapes working directory/);
        const plugin = pathEscapePlugin(cwd, () => []);
        const handler = plugin.middleware
          ? plugin.middleware(nextHandler)
          : nextHandler;
        const result = await handler(
          makeCall("read_file", { path: forged }),
          new AbortController().signal,
        );
        expect(result.isError).toBe(true);
        expect(result.content).toMatch(/escapes working directory/);
      } finally {
        await rm(cwd, { recursive: true, force: true });
        await rm(outsideDir, { recursive: true, force: true });
      }
    });

    test("an in-bounds file cursor and a blob cursor keep the read_file exemption", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "corbits-escape-cursor-ok-"));
      const insidePath = join(cwd, "notes.txt");
      await writeFile(insidePath, "notes");
      try {
        const inBounds = encodeResumeCursor({
          source: { kind: "file", path: insidePath },
          offset: 4,
          limit: 4,
          nonce: "minted-nonce",
        } satisfies ResumeCursor);
        expect(
          pathEscapeBlockReason({ path: inBounds }, cwd, () => [], "read_file"),
        ).toBeUndefined();
        const blob = encodeResumeCursor({
          source: { kind: "blob", uri: "tool-output:///abc123" },
          offset: 0,
          limit: 4,
          nonce: "blob-nonce",
        } satisfies ResumeCursor);
        expect(
          pathEscapeBlockReason({ path: blob }, cwd, () => [], "read_file"),
        ).toBeUndefined();
        const plugin = pathEscapePlugin(cwd, () => []);
        const next = async (call: ToolCall): Promise<ToolResult> => ({
          callId: call.id,
          content: JSON.stringify(call.arguments),
        });
        const handler = plugin.middleware ? plugin.middleware(next) : next;
        const result = await handler(
          makeCall("read_file", { path: inBounds }),
          new AbortController().signal,
        );
        expect(result.isError).not.toBe(true);
        const args = JSON.parse(String(result.content)) as { path: string };
        expect(args.path).toBe(inBounds);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    test("archive refs pass for archive readers but not for other tools", async () => {
      for (const name of ["read_file", "grep", "search_files"]) {
        expect(
          pathEscapeBlockReason(
            { path: "archive:///occ-abc" },
            "/project",
            () => [],
            name,
          ),
        ).toBeUndefined();
      }
      expect(
        pathEscapeBlockReason(
          { path: "archive:///occ-abc" },
          "/project",
          () => [],
          "write_file",
        ),
      ).toMatch(/archive/);
      const plugin = pathEscapePlugin("/project");
      const handler = plugin.middleware
        ? plugin.middleware(nextHandler)
        : nextHandler;
      const blocked = await handler(
        makeCall("write_file", {
          path: "archive:///occ-abc",
          content: "hi",
        }),
        new AbortController().signal,
      );
      expect(blocked.isError).toBe(true);
    });

    test("omitted toolName fails closed on virtual refs", () => {
      const omitted = undefined as unknown as string;
      expect(
        pathEscapeBlockReason(
          { path: "tool-output:///abc123" },
          "/project",
          () => [],
          omitted,
        ),
      ).toMatch(/tool-output/);
      expect(
        pathEscapeBlockReason(
          { path: "archive:///occ-abc" },
          "/project",
          () => [],
          omitted,
        ),
      ).toMatch(/archive/);
    });

    test("allowOutside still denies a non-reader virtual ref at execution", async () => {
      const plugin = pathEscapePlugin("/project", () => [], {
        allowOutside: true,
      });
      const handler = plugin.middleware
        ? plugin.middleware(nextHandler)
        : nextHandler;
      const spill = await handler(
        makeCall("grep", {
          pattern: "foo",
          path: "tool-output:///abc123",
        }),
        new AbortController().signal,
      );
      expect(spill.isError).toBe(true);
      expect(spill.content).toMatch(/tool-output/);
      const archive = await handler(
        makeCall("write_file", {
          path: "archive:///occ-abc",
          content: "hi",
        }),
        new AbortController().signal,
      );
      expect(archive.isError).toBe(true);
      expect(archive.content).toMatch(/archive/);
    });
  });

  test("read of a trusted plugin root is not a path-escape deny", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "corbits-escape-plugin-cwd-"));
    const pluginDir = await mkdtemp(
      join(tmpdir(), "corbits-escape-plugin-root-"),
    );
    const target = join(pluginDir, "skill.md");
    await writeFile(target, "body");
    try {
      const plugin = pathEscapePlugin(cwd, () => [], {
        trustedPluginRoots: () => [pluginDir],
      });
      const next = async (call: ToolCall): Promise<ToolResult> => ({
        callId: call.id,
        content: JSON.stringify(call.arguments),
      });
      const handler = plugin.middleware ? plugin.middleware(next) : next;
      const result = await handler(
        makeCall("read_file", { path: target }),
        new AbortController().signal,
      );
      expect(result.isError).not.toBe(true);
      const args = JSON.parse(String(result.content)) as { path: string };
      expect(args.path).toBe(realpathSync(target));
      expect(
        pathEscapeBlockReason(
          { path: target },
          cwd,
          () => [],
          "read_file",
          () => [pluginDir],
        ),
      ).toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(pluginDir, { recursive: true, force: true });
    }
  });

  test("write of a trusted plugin root stays a path-escape deny", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "corbits-escape-plugin-w-cwd-"));
    const pluginDir = await mkdtemp(
      join(tmpdir(), "corbits-escape-plugin-w-root-"),
    );
    const target = join(pluginDir, "skill.md");
    await writeFile(target, "body");
    try {
      const plugin = pathEscapePlugin(cwd, () => [], {
        trustedPluginRoots: () => [pluginDir],
      });
      const handler = plugin.middleware
        ? plugin.middleware(nextHandler)
        : nextHandler;
      const result = await handler(
        makeCall("write_file", { path: target, content: "x" }),
        new AbortController().signal,
      );
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/escapes working directory/);
      expect(
        pathEscapeBlockReason(
          { path: target, content: "x" },
          cwd,
          () => [],
          "write_file",
          () => [pluginDir],
        ),
      ).toMatch(/escapes working directory/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(pluginDir, { recursive: true, force: true });
    }
  });
});
