import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { withMockedModule } from "../../../tests/helpers/mock-module.js";

// Reused by both the TUI and exec boot paths (src/tui/runner.ts,
// src/exec/runner.ts) to refresh the pinned Codex instructions before first
// Codex inference. This exercises the shared refresh/fallback logic directly,
// with disk I/O faked so tests never touch the real ~/.corbits cache.

let fakeDisk = new Map<string, string>();

await withMockedModule(import.meta.resolve("node:fs"), (real: typeof import("node:fs")) => ({
  ...real,
  readFileSync: (path: string) => {
    const contents = fakeDisk.get(path);
    if (contents === undefined) {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }
    return contents;
  },
  writeFileSync: (path: string, contents: string) => {
    fakeDisk.set(path, contents);
  },
  mkdirSync: () => undefined,
}));

const { refreshCodexInstructions, codexInstructions, codexInstructionsHash } =
  await import("./instructions.js");
const { GPT_5_CODEX_PROMPT } = await import("./prompts/gpt-5-codex.js");

const VALID_PROMPT = `You are Codex${"x".repeat(1200)}`;

function mockFetchSequence(tag: string, promptResponse: () => Response): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("releases/latest")) {
      return new Response(JSON.stringify({ tag_name: tag }), { status: 200 });
    }
    return promptResponse();
  }) as typeof fetch;
}

describe("refreshCodexInstructions", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    fakeDisk = new Map();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("bundled copy is used before any refresh", () => {
    expect(codexInstructions()).toBe(GPT_5_CODEX_PROMPT);
  });

  test("updates in-memory instructions on a successful fetch", async () => {
    global.fetch = mockFetchSequence(
      "rust-v1.2.3",
      () => new Response(VALID_PROMPT, { status: 200 }),
    );

    await refreshCodexInstructions();
    expect(codexInstructions()).toBe(VALID_PROMPT);
  });

  test("falls back without throwing the run when the release lookup network call fails", async () => {
    const before = codexInstructions();
    global.fetch = (() => Promise.reject(new Error("network down"))) as unknown as typeof fetch;

    // The function itself rejects; callers (TUI/exec boot) catch this and
    // keep running on cache/bundled instructions — see src/exec/runner.ts and
    // src/tui/runner.ts refresh call sites.
    await expect(refreshCodexInstructions()).rejects.toThrow("network down");
    expect(codexInstructions()).toBe(before);
  });

  test("falls back without throwing when the prompt fetch returns a non-200", async () => {
    const before = codexInstructions();
    global.fetch = mockFetchSequence(
      "rust-v1.2.3",
      () => new Response("not found", { status: 404 }),
    );

    await expect(refreshCodexInstructions()).rejects.toThrow(/HTTP 404/);
    expect(codexInstructions()).toBe(before);
  });

  test("rejects a 200 response whose body is not a valid Codex prompt (CDN error page)", async () => {
    const before = codexInstructions();
    global.fetch = mockFetchSequence(
      "rust-v1.2.3",
      () => new Response("<html>oops</html>", { status: 200 }),
    );

    await expect(refreshCodexInstructions()).rejects.toThrow(/unexpected body/);
    expect(codexInstructions()).toBe(before);
  });

  test("rejects within the timeout when a fetch never resolves (hung connection)", async () => {
    const before = codexInstructions();
    global.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () => reject(signal.reason as Error));
        }
      });
    }) as unknown as typeof fetch;

    const started = Date.now();
    await expect(refreshCodexInstructions()).rejects.toBeTruthy();
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(codexInstructions()).toBe(before);
  }, 20_000);

  test("codexInstructionsHash reflects the currently resolved instructions text", async () => {
    const hashBefore = codexInstructionsHash();
    expect(hashBefore).toMatch(/^[0-9a-f]{12}$/);

    const otherPrompt = `You are Codex${"y".repeat(1200)}`;
    global.fetch = mockFetchSequence(
      "rust-v1.2.4",
      () => new Response(otherPrompt, { status: 200 }),
    );
    await refreshCodexInstructions();

    expect(codexInstructionsHash()).not.toBe(hashBefore);
  });
});
