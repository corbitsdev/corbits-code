import { describe, expect, test } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";

import { DenialMemory, stableRequestId } from "./denial-memory.js";

const fetchCall = (id: string, url: string): ToolCall => ({
  id,
  name: "web_fetch",
  arguments: { url, format: "markdown" },
});

describe("stableRequestId", () => {
  test("same URL across distinct call ids shares one fingerprint", () => {
    expect(
      stableRequestId(fetchCall("call_0", "https://example.com/docs"), "/work"),
    ).toBe(
      stableRequestId(fetchCall("call_1", "https://example.com/docs"), "/work"),
    );
  });

  test("different URLs have independent fingerprints", () => {
    expect(
      stableRequestId(fetchCall("call_0", "https://example.com/docs"), "/work"),
    ).not.toBe(
      stableRequestId(
        fetchCall("call_1", "https://example.com/other"),
        "/work",
      ),
    );
  });

  test("scheme/host case and trailing slashes normalize to one fingerprint", () => {
    expect(
      stableRequestId(fetchCall("call_0", "https://example.com/docs"), "/work"),
    ).toBe(
      stableRequestId(
        fetchCall("call_1", "HTTPS://EXAMPLE.COM/docs/"),
        "/work",
      ),
    );
  });

  // URL paths and queries are case-sensitive (RFC 3986): /Docs and /docs
  // must fingerprint distinctly.
  test("case-distinct paths and queries have independent fingerprints", () => {
    expect(
      stableRequestId(fetchCall("call_0", "https://example.com/Docs"), "/work"),
    ).not.toBe(
      stableRequestId(fetchCall("call_1", "https://example.com/docs"), "/work"),
    );
    expect(
      stableRequestId(
        fetchCall("call_0", "https://example.com/search?q=ABC"),
        "/work",
      ),
    ).not.toBe(
      stableRequestId(
        fetchCall("call_1", "https://example.com/search?q=abc"),
        "/work",
      ),
    );
  });

  test("tool name participates in the fingerprint", () => {
    const args = { url: "https://example.com/docs" };
    expect(
      stableRequestId({ id: "a", name: "web_fetch", arguments: args }, "/work"),
    ).not.toBe(
      stableRequestId(
        { id: "a", name: "web_search", arguments: args },
        "/work",
      ),
    );
  });

  test("same shell command across distinct call ids shares one fingerprint", () => {
    const shellCall = (id: string, command: string): ToolCall => ({
      id,
      name: "run_shell",
      arguments: { command },
    });
    expect(
      stableRequestId(shellCall("call_0", "echo alpha && echo beta"), "/work"),
    ).toBe(
      stableRequestId(shellCall("call_1", "echo alpha && echo beta"), "/work"),
    );
    expect(
      stableRequestId(shellCall("call_2", "echo alpha && echo beta"), "/work"),
    ).not.toBe(stableRequestId(shellCall("call_3", "echo gamma"), "/work"));
  });
});

describe("DenialMemory", () => {
  test("a same-fingerprint retry returns the cached reason", () => {
    const memory = new DenialMemory();
    const first = stableRequestId(
      fetchCall("call_0", "https://example.com/docs"),
      "/work",
    );
    const retry = stableRequestId(
      fetchCall("call_1", "https://example.com/docs"),
      "/work",
    );
    expect(memory.isDenied(first)).toBeUndefined();
    memory.record(first, "denied: needs approval");
    expect(memory.isDenied(retry)).toBe("denied: needs approval");
  });

  test("first recorded reason wins; clear forgets every denial", () => {
    const memory = new DenialMemory();
    const stableId = stableRequestId(
      fetchCall("call_0", "https://example.com/docs"),
      "/work",
    );
    memory.record(stableId, "first");
    memory.record(stableId, "second");
    expect(memory.isDenied(stableId)).toBe("first");
    memory.clear();
    expect(memory.isDenied(stableId)).toBeUndefined();
  });
});
