import { describe, expect, test } from "bun:test";
import { createBlobReader } from "@intx/types/runtime";
import { createPosixTools } from "@intx/tools-posix";
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
});