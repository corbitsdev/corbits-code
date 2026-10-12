import { describe, expect, test } from "bun:test";
import { withMockedModule } from "../../testkit/mock-module.js";

// Spy on createHash to prove toolSetDigest memoizes: repeated digest calls
// with the same tool array must run the sha256 exactly once, and a new array
// (tools changed) must run it again. The mock delegates to the real
// implementation (captured before mocking) so behavior is unchanged;
// hashCalls only measures the delta around each assertion.
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

// Dynamic import so director.ts resolves node:crypto through the mock above.
const { toolSetDigest } = await import("./director.js");

const base = {
  name: "read_file",
  description: "read a file",
  inputSchema: { type: "object" },
};

describe("toolSetDigest memoization", () => {
  test("hashes once per tool set across repeated digest calls", () => {
    const tools = [{ ...base }];
    hashCalls = 0;
    const first = toolSetDigest(tools);
    const second = toolSetDigest(tools);
    const third = toolSetDigest(tools);
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(hashCalls).toBe(1);
  });

  test("recomputes when a new tool set arrives", () => {
    const tools = [{ ...base }];
    const changed = [{ ...base, description: "changed" }];
    hashCalls = 0;
    const digest = toolSetDigest(tools);
    expect(hashCalls).toBe(1);
    const changedDigest = toolSetDigest(changed);
    expect(hashCalls).toBe(2);
    expect(changedDigest).not.toBe(toolSetDigest(tools));
    expect(digest).toBe(toolSetDigest(tools));
  });
});
