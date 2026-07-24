import { describe, expect, test } from "bun:test";
import { createBlobReader } from "@intx/types/runtime";
import { createPosixTools } from "@intx/tools-posix";
import { readFileGuardPlugin } from "./read-file-guard-plugin.js";
import { ripgrepPlugin } from "./ripgrep-plugin.js";
import { toolOutputUriPlugin } from "./tool-output-uri-plugin.js";

describe("toolOutputUriPlugin", () => {
  test("normalizes tool-output:/id on read_file", async () => {
    const encoder = new TextEncoder();
    const blobReader = createBlobReader({
      async readBlob(key: string) {
        if (key === "abc123") {
          return encoder.encode("payload");
        }
        throw new Error(`missing ${key}`);
      },
    });
    const tools = createPosixTools({
      cwd: "/tmp",
      blobReader,
      plugins: [toolOutputUriPlugin()],
    });
    const result = await tools.run(
      {
        id: "r1",
        name: "read_file",
        arguments: { path: "tool-output:/abc123" },
      },
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("payload");
  });

  test("normalizes mistaken URI then read-file guard pages without stock split", async () => {
    const encoder = new TextEncoder();
    const lines = Array.from({ length: 5_000 }, (_, i) => `blob-line-${i}`).join("\n");
    const blobReader = createBlobReader({
      async readBlob(key) {
        if (key === "paged") return encoder.encode(lines);
        throw new Error(`missing ${key}`);
      },
    });
    const tools = createPosixTools({
      cwd: "/tmp",
      blobReader,
      plugins: [toolOutputUriPlugin(), readFileGuardPlugin("/tmp", { blobReader })],
    });
    const result = await tools.run(
      {
        id: "r2",
        name: "read_file",
        arguments: { path: "tool-output:/paged", offset: 100, limit: 2 },
      },
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("blob-line-100");
    expect(result.content).toContain("blob-line-101");
    expect(result.content).not.toContain("blob-line-99");
  });

  test("rejects grep on a tool-output:// URI before it reaches ripgrep", async () => {
    const tools = createPosixTools({
      cwd: "/tmp",
      plugins: [toolOutputUriPlugin(), ripgrepPlugin("/tmp")],
    });
    const result = await tools.run(
      {
        id: "g1",
        name: "grep",
        arguments: { pattern: "foo", path: "tool-output:///abc123" },
      },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("read_file");
    expect(result.content).not.toContain("ripgrep");
  });

  test("rejects search_files on a tool-output:// URI before it reaches ripgrep", async () => {
    const tools = createPosixTools({
      cwd: "/tmp",
      plugins: [toolOutputUriPlugin(), ripgrepPlugin("/tmp")],
    });
    const result = await tools.run(
      {
        id: "s1",
        name: "search_files",
        arguments: { pattern: "*.ts", path: "tool-output:///abc123" },
      },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("read_file");
  });
});