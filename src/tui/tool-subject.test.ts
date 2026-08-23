/**
 * A tool row's subject is one argument.
 *
 * A serialised argument list spends the row's columns naming keys and then cuts
 * the second value off mid-word ("numR…"), which says nothing at all. The row
 * names the argument the call is about; the rest is behind the arrow.
 */
import { describe, expect, test } from "bun:test";

import { toolArgsView } from "./tool-args";

const view = (name: string, args: Record<string, unknown>) =>
  toolArgsView(name, JSON.stringify(args));

describe("a summarised call's subject", () => {
  test("is the query alone, not a list ending in a fragment", () => {
    const summary = view("web_search", {
      query: "Apple Inc company overview apple.com official",
      numResults: 5,
    })?.summary;
    expect(summary).toBe("Apple Inc company overview apple.com official");
    expect(summary).not.toContain("numResults");
    expect(summary).not.toContain(":");
  });

  test("drops the key prefix a URL or pattern used to carry", () => {
    expect(view("web_fetch", { url: "https://www.apple.com" })?.summary).toBe(
      "https://www.apple.com",
    );
    expect(view("grep", { pattern: "TODO", path: "src" })?.summary).toBe("TODO");
  });

  test("keeps the dropped arguments behind the expand arrow", () => {
    const detail = view("web_search", { query: "apple", numResults: 5 })?.detail;
    const plain = (detail ?? [])
      .map((line) => line.map((segment) => segment.text).join(""))
      .join("\n");
    expect(plain).toContain("numResults");
    expect(plain).toContain("5");
  });

  test("earns no arrow when the one argument is the whole call", () => {
    expect(view("web_fetch", { url: "https://www.apple.com" })?.detail).toBeUndefined();
  });

  test("leaves a tool that already names itself alone", () => {
    // The formatter shortens a path and abbreviates a task description; those
    // are better subjects than any raw argument value.
    expect(view("read_file", { path: "src/index.ts" })?.summary).toBe("src/index.ts");
  });
});
