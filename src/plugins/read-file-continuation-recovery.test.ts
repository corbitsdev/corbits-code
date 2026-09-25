import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import { defined } from "../../tests/helpers/defined.js";
import {
  APPROVER_REJECTION_MARKER,
  BLOCKED_BY_POLICY_PREFIX,
  DENIED_BY_POLICY_MARKER,
  NO_MATCHING_GRANTS_MARKER,
  OPERATOR_DECLINED_MARKER,
} from "../permission/decline-markers.js";
import type { PermissionGate } from "../permission/gate.js";
import { gateToolCall } from "./permission-plugin.js";
import { pathEscapePlugin } from "./path-escape-plugin.js";
import { encodeResumeCursor } from "../util/tool-output-uri.js";
import { readFileGuardPlugin } from "./read-file-guard-plugin.js";

// CL-8980 RED: continuation recovery. Truncated reads mint a one-shot
// in-memory handle; after resume (fresh plugin instance), prune, or
// compaction the record is dropped and the URI is indistinguishable from a
// missing spill, with no source/offset named. These tests pin the recovery
// contract: verbatim handle-following yields the next window across resume,
// dead handles name source + offset (never a bare missing-blob), never-handles
// still fail as missing blobs, spent replays stay errors with one followable
// next call, and guard denials stay isError results (never throws, never a
// decline classification).

const neverAbort = () => new AbortController().signal;

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "read-continuation-8980-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function fixture(name: string, content: string): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, content);
  return p;
}

const fallback = async (call: ToolCall): Promise<ToolResult> => ({
  callId: call.id,
  content: "FALLBACK",
});

function freshGuard(blobReader?: {
  read: (uri: string) => Promise<Uint8Array>;
}) {
  const plugin = readFileGuardPlugin(
    dir,
    blobReader !== undefined ? { blobReader } : {},
  );
  const middleware = defined(plugin.middleware)(fallback);
  return (call: ToolCall) => middleware(call, neverAbort());
}

function extractHandle(content: string): string {
  const match = /Use path="(tool-output:\/\/\/[^"]+)"/.exec(content);
  expect(match).not.toBeNull();
  return (match as RegExpExecArray)[1] as string;
}

function tenLines(name: string): string {
  return Array.from({ length: 10 }, (_, i) => `${name}-line-${i}`).join("\n");
}

// Decline-classification markers the director matches by substring. No
// continuation isError may carry any of them, or a recoverable read failure
// would be misread as an operator decision (src/agent/director.ts must stay
// out of this path).
const DECLINE_MARKERS = [
  DENIED_BY_POLICY_MARKER,
  NO_MATCHING_GRANTS_MARKER,
  OPERATOR_DECLINED_MARKER,
  APPROVER_REJECTION_MARKER,
];

function expectNotDeclined(content: string): void {
  for (const marker of DECLINE_MARKERS) {
    expect(content).not.toContain(marker);
  }
}

describe("CL-8980 continuation recovery (file source)", () => {
  test("verbatim follow after session resume yields the next window", async () => {
    const absolutePath = await fixture("resume.txt", tenLines("resume"));
    const first = await freshGuard()({
      id: "r1",
      name: "read_file",
      arguments: { path: "resume.txt", limit: 4 },
    });
    expect(first.isError).toBeFalsy();
    const handle = extractHandle(String(first.content));

    // A resumed session rebuilds the plugin: brand-new instance, empty
    // in-memory cursor map. Following the notice verbatim must still yield
    // the next window, not a missing-blob dead end. Same window size so the
    // read stays paged and mints the next handle.
    const resumed = await freshGuard()({
      id: "r2",
      name: "read_file",
      arguments: { path: handle, limit: 4 },
    });
    expect(resumed.isError).toBeFalsy();
    expect(String(resumed.content)).toContain("resume-line-4");
    // CL-8980 keeps a plain path+offset fallback alongside the handle so a
    // lost handle is never a dead end; verbatim follows still use the handle.
    expect(String(resumed.content)).toContain(`path="${absolutePath}"`);
    expect(String(resumed.content)).not.toMatch(/Use path="[^"]*resume\.txt"/);
    expectNotDeclined(String(resumed.content));
  });

  test("verbatim follow chains across a second hop after resume", async () => {
    await fixture("chain.txt", tenLines("chain"));
    const first = await freshGuard()({
      id: "c1",
      name: "read_file",
      arguments: { path: "chain.txt", limit: 4 },
    });
    const handle1 = extractHandle(String(first.content));

    const second = await freshGuard()({
      id: "c2",
      name: "read_file",
      arguments: { path: handle1, limit: 4 },
    });
    expect(second.isError).toBeFalsy();
    expect(String(second.content)).toContain("chain-line-4");
    const handle2 = extractHandle(String(second.content));
    expect(handle2).not.toBe(handle1);

    const third = await freshGuard()({
      id: "c3",
      name: "read_file",
      arguments: { path: handle2, limit: 4 },
    });
    expect(third.isError).toBeFalsy();
    expect(String(third.content)).toContain("chain-line-8");
  });

  test("dead file handle names the source and offset, never a bare missing blob", async () => {
    const absolutePath = await fixture("gone.txt", tenLines("gone"));
    const first = await freshGuard()({
      id: "d1",
      name: "read_file",
      arguments: { path: "gone.txt", limit: 4 },
    });
    const handle = extractHandle(String(first.content));
    await unlink(absolutePath);

    const dead = await freshGuard()({
      id: "d2",
      name: "read_file",
      arguments: { path: handle },
    });
    expect(dead.isError).toBe(true);
    const text = String(dead.content);
    expect(text).toContain(absolutePath);
    expect(text).toMatch(/offset=4\b/);
    expect(text).not.toContain("Blob not found");
    expect(text).not.toContain("no blob reader is configured");
    expectNotDeclined(text);
  });

  test("spent-handle replay stays an error with one followable next call", async () => {
    const absolutePath = await fixture("spent.txt", tenLines("spent"));
    const plugin = readFileGuardPlugin(dir, {});
    const middleware = defined(plugin.middleware)(fallback);
    const first = await middleware(
      {
        id: "s1",
        name: "read_file",
        arguments: { path: "spent.txt", limit: 4 },
      },
      neverAbort(),
    );
    const handle = extractHandle(String(first.content));
    const second = await middleware(
      { id: "s2", name: "read_file", arguments: { path: handle } },
      neverAbort(),
    );
    expect(second.isError).toBeFalsy();

    const replay = await middleware(
      { id: "s3", name: "read_file", arguments: { path: handle } },
      neverAbort(),
    );
    expect(replay.isError).toBe(true);
    const text = String(replay.content);
    expect(text).toContain("already used");
    expect(text).toContain(absolutePath);
    expect(text).toMatch(/offset=4\b/);
    // Exactly one followable next call, not a menu of guesses.
    expect(text.match(/offset=/g)).toHaveLength(1);
    expectNotDeclined(text);
  });
});

describe("CL-8980 continuation recovery (blob source)", () => {
  const enc = new TextEncoder();
  const rows = Array.from({ length: 8_000 }, (_, i) => `row-${i}`).join("\n");

  test("verbatim follow after resume yields the next window without the old map", async () => {
    const store = new Map<string, Uint8Array>([
      ["spill-resume", enc.encode(rows)],
    ]);
    const opening = freshGuard({
      read: async (uri: string) => {
        const key = uri.slice("tool-output:///".length);
        const bytes = store.get(key);
        if (bytes === undefined)
          throw new Error(`Blob not found for key: ${uri}`);
        return bytes;
      },
    });
    const first = await opening({
      id: "b1",
      name: "read_file",
      arguments: { path: "tool-output:///spill-resume", limit: 5 },
    });
    expect(first.isError).toBeFalsy();
    const handle = extractHandle(String(first.content));

    // Resumed session: new plugin instance, same durable spill store.
    const resumed = freshGuard({
      read: async (uri: string) => {
        const key = uri.slice("tool-output:///".length);
        const bytes = store.get(key);
        if (bytes === undefined)
          throw new Error(`Blob not found for key: ${uri}`);
        return bytes;
      },
    });
    const second = await resumed({
      id: "b2",
      name: "read_file",
      arguments: { path: handle },
    });
    expect(second.isError).toBeFalsy();
    expect(String(second.content)).toContain("row-5");
  });

  test("dead spill handle names the spill URI and offset, never a bare missing blob", async () => {
    const live = new Map<string, Uint8Array>([
      ["spill-dead", enc.encode(rows)],
    ]);
    const opening = freshGuard({
      read: async (uri: string) => {
        const key = uri.slice("tool-output:///".length);
        const bytes = live.get(key);
        if (bytes === undefined)
          throw new Error(`Blob not found for key: ${uri}`);
        return bytes;
      },
    });
    const first = await opening({
      id: "e1",
      name: "read_file",
      arguments: { path: "tool-output:///spill-dead", limit: 5 },
    });
    const handle = extractHandle(String(first.content));

    // The spill is gone (pruned store) by the time the handle is followed.
    const pruned = freshGuard({
      read: async (uri: string) => {
        throw new Error(`Blob not found for key: ${uri}`);
      },
    });
    const dead = await pruned({
      id: "e2",
      name: "read_file",
      arguments: { path: handle },
    });
    expect(dead.isError).toBe(true);
    const text = String(dead.content);
    expect(text).toContain("tool-output:///spill-dead");
    expect(text).toMatch(/offset=\d+\b/);
    expect(text).not.toMatch(
      /Blob not found for key: tool-output:\/\/\/[0-9a-f-]+/,
    );
    expectNotDeclined(text);
  });

  test("a URI that was never a continuation handle still fails as a missing blob", async () => {
    const result = await freshGuard({
      read: async (uri: string) => {
        throw new Error(`Blob not found for key: ${uri}`);
      },
    })({
      id: "u1",
      name: "read_file",
      arguments: { path: "tool-output:///never-minted" },
    });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("Blob not found for key");
    expect(String(result.content)).not.toContain("already used");
    expectNotDeclined(String(result.content));
  });
});

describe("CL-8980 forged continuation handle is denied end to end", () => {
  function stackedGuard() {
    const guard = defined(readFileGuardPlugin(dir, {}).middleware)(fallback);
    const stacked = defined(pathEscapePlugin(dir, () => []).middleware)(guard);
    return (call: ToolCall) => stacked(call, neverAbort());
  }

  test("a hand-crafted cursor for an unminted outside-root path is denied, not served", async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), "read-forged-outside-"));
    const outsidePath = join(outsideDir, "secret.txt");
    await writeFile(outsidePath, "forged-handle-secret-payload");
    try {
      const forged = encodeResumeCursor({
        source: { kind: "file", path: outsidePath },
        offset: 0,
        limit: 4,
        nonce: "never-minted",
      });
      const result = await stackedGuard()({
        id: "f1",
        name: "read_file",
        arguments: { path: forged },
      });
      expect(result.isError).toBe(true);
      expect(String(result.content)).toMatch(/escapes working directory/);
      expect(String(result.content)).not.toContain(
        "forged-handle-secret-payload",
      );
      expectNotDeclined(String(result.content));
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  test("a minted in-bounds handle is still served through the same stack", async () => {
    await fixture("stacked.txt", tenLines("stacked"));
    const stack = stackedGuard();
    const first = await stack({
      id: "s1",
      name: "read_file",
      arguments: { path: "stacked.txt", limit: 4 },
    });
    expect(first.isError).toBeFalsy();
    const handle = extractHandle(String(first.content));
    const second = await stackedGuard()({
      id: "s2",
      name: "read_file",
      arguments: { path: handle, limit: 4 },
    });
    expect(second.isError).toBeFalsy();
    expect(String(second.content)).toContain("stacked-line-4");
  });
});

describe("CL-8980 guard-denied continuation stays isError (never throws)", () => {
  test("a denied continuation follow returns isError with the reason", async () => {
    const gate = {
      isReactorGated: () => false,
      evaluate: async () => ({
        allowed: false as const,
        reason: "test policy: cursor follows need approval",
      }),
    } as unknown as PermissionGate;
    const call: ToolCall = {
      id: "g1",
      name: "read_file",
      arguments: { path: "tool-output:///cursor-deadbeef" },
    };
    let result: ToolResult | undefined;
    await expect(
      (async () => {
        result = await gateToolCall(gate, call, neverAbort(), async () => {
          throw new Error("must not reach the tool when denied");
        });
      })(),
    ).resolves.toBeUndefined();
    expect(defined(result).isError).toBe(true);
    expect(String(defined(result).content)).toContain(
      `${BLOCKED_BY_POLICY_PREFIX}test policy: cursor follows need approval`,
    );
    expectNotDeclined(String(defined(result).content));
  });
});
