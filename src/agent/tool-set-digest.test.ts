import { describe, expect, test } from "bun:test";
import { withMockedModule } from "../../testkit/mock-module.js";

// Spy on createHash to prove toolSetDigest memoizes per director: installing
// a tool set runs the sha256 exactly once for that set, and comparing a later
// update against the stored per-director digest must not re-hash the previous
// set. The mock delegates to the real implementation (captured before mocking)
// so behavior is unchanged; hashCalls only measures the delta around each
// assertion.
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

    // Warm-up installs `tools`; its digest is stored on the director.
    director.updateToolDefinitions(tools);
    hashCalls = 0;
    // The previous set's digest comes from the per-director field (no re-hash);
    // only the incoming set is hashed.
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
    // A fresh reference (even with identical content) misses the stored slot
    // and re-runs the hash; the digest gates the tool-set-changed log, so
    // identical content still logs nothing.
    director.updateToolDefinitions([{ ...base }]);
    expect(hashCalls).toBe(1);
  });
});
