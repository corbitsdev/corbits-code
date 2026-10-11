/** A tool row's subject is one argument — a serialised list spends the row
 * naming keys and cuts the second value off mid-word ("numR…"). The rest
 * stays behind the arrow. */
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
    expect(view("grep", { pattern: "TODO", path: "src" })?.summary).toBe(
      "TODO",
    );
  });

  test("keeps the dropped arguments behind the expand arrow", () => {
    const detail = view("web_search", {
      query: "apple",
      numResults: 5,
    })?.detail;
    const plain = (detail ?? [])
      .map((line) => line.map((segment) => segment.text).join(""))
      .join("\n");
    expect(plain).toContain("numResults");
    expect(plain).toContain("5");
  });

  test("earns no arrow when the one argument is the whole call", () => {
    expect(
      view("web_fetch", { url: "https://www.apple.com" })?.detail,
    ).toBeUndefined();
  });

  test("leaves a tool that already names itself alone", () => {
    // The formatter's subjects beat any raw argument value.
    expect(view("read_file", { path: "src/index.ts" })?.summary).toBe(
      "src/index.ts",
    );
  });
});
