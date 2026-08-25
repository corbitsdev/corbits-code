import { describe, expect, test } from "bun:test";
import {
  materializeToolResultContent,
  materializeToolResultRecord,
  toolOutputAbsolutePath,
} from "./tool-result-materialize.js";

describe("materializeToolResultContent", () => {
  test("pretty-prints a minified JSON object as application/json", () => {
    const minified = JSON.stringify({ a: 1, b: [2, 3], nested: { ok: true } });
    const out = materializeToolResultContent(minified);
    expect(out.contentType).toBe("application/json");
    expect(out.text).toBe(JSON.stringify(JSON.parse(minified), null, 2));
    expect(out.text).toContain("\n");
  });

  test("pretty-prints a minified JSON array", () => {
    const minified = JSON.stringify([{ id: 1 }, { id: 2 }]);
    const out = materializeToolResultContent(minified);
    expect(out.contentType).toBe("application/json");
    expect(out.text).toBe(JSON.stringify(JSON.parse(minified), null, 2));
  });

  test("preserves NDJSON (two or more JSON lines) without reformatting", () => {
    const ndjson = `${JSON.stringify({ n: 1 })}\n${JSON.stringify({ n: 2 })}\n`;
    const out = materializeToolResultContent(ndjson);
    expect(out.contentType).toBe("application/x-ndjson");
    expect(out.text).toBe(ndjson);
  });

  test("classifies CRLF-delimited NDJSON without rewriting the bytes", () => {
    const ndjson = `${JSON.stringify({ n: 1 })}\r\n${JSON.stringify({ n: 2 })}\r\n`;
    const out = materializeToolResultContent(ndjson);
    expect(out.contentType).toBe("application/x-ndjson");
    expect(out.text).toBe(ndjson);
  });

  test("leaves non-JSON text as text/plain", () => {
    const raw = "hello\nworld\nnot json";
    expect(materializeToolResultContent(raw)).toEqual({
      text: raw,
      contentType: "text/plain",
    });
  });

  test("skips pretty-print for huge payloads and returns text/plain", () => {
    // Over the ~8MB ceiling: starts like JSON but must not be parsed/pretty-printed.
    const huge = `{"k":"${"x".repeat(9 * 1024 * 1024)}"}`;
    const out = materializeToolResultContent(huge);
    expect(out.contentType).toBe("text/plain");
    expect(out.text).toBe(huge);
  });
});

describe("materializeToolResultRecord", () => {
  test("pretty-serializes a Record as application/json", () => {
    const out = materializeToolResultRecord({ hello: "world", n: 1 });
    expect(out.contentType).toBe("application/json");
    expect(out.text).toBe(JSON.stringify({ hello: "world", n: 1 }, null, 2));
  });
});

describe("toolOutputAbsolutePath", () => {
  test("mirrors store naming including :full → _full and .json extension", () => {
    const abs = toolOutputAbsolutePath("/tmp/session/context", "call-42:full", "application/json");
    expect(abs).toBe("/tmp/session/context/tool-output/call-42_full.json");
  });

  test("uses .txt for text/plain and no extension for unknown types", () => {
    expect(toolOutputAbsolutePath("/c", "k", "text/plain")).toBe("/c/tool-output/k.txt");
    expect(toolOutputAbsolutePath("/c", "k", "application/x-ndjson")).toBe("/c/tool-output/k");
  });
});
