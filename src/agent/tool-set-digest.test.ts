import { describe, expect, test } from "bun:test";
import { withMockedModule } from "../../testkit/mock-module.js";

let hashCalls = 0;
await withMockedModule<typeof import("node:crypto")>(
  import.meta.resolve("node:crypto"),
  (real) => ({
    ...real,
    createHash: (algorithm: string) => {
      hashCalls += 1;
      return real.createHash(algorithm);
    },
  }),
);

const { createChatDirector } = await import("./director.js");

const base = {
  name: "read_file",
  description: "read a file",
  inputSchema: { type: "object" },
};

describe("toolSetDigest memoization", () => {
  test("hashes each installed tool set once per director", () => {
    const director = createChatDirector("system", [], {});
    const tools = [{ ...base }];
    const changed = [{ ...base, description: "changed" }];

    director.updateToolDefinitions(tools);
    hashCalls = 0;
    director.updateToolDefinitions(changed);
    expect(hashCalls).toBe(1);
  });

  test("recomputes when a new tool set arrives", () => {
    const director = createChatDirector("system", [], {});
    const tools = [{ ...base }];
    const changed = [{ ...base, description: "changed" }];

    director.updateToolDefinitions(tools);
    director.updateToolDefinitions(changed);
    hashCalls = 0;
    director.updateToolDefinitions([{ ...base }]);
    expect(hashCalls).toBe(1);
  });
});
