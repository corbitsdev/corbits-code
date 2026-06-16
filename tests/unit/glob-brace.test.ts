import { describe, test, expect } from "bun:test";
import { matchGlob } from "../../src/util/glob.js";

describe("brace expansion in glob patterns", () => {
  test("single brace group: *.{ts,tsx} matches .ts files", () => {
    expect(matchGlob("*.{ts,tsx}", "foo.ts")).toBe(true);
  });

  test("single brace group: *.{ts,tsx} matches .tsx files", () => {
    expect(matchGlob("*.{ts,tsx}", "foo.tsx")).toBe(true);
  });

  test("single brace group: *.{ts,tsx} does not match .js files", () => {
    expect(matchGlob("*.{ts,tsx}", "foo.js")).toBe(false);
  });

  test("double-star with brace: **/*.{ts,tsx} matches nested .ts", () => {
    expect(matchGlob("**/*.{ts,tsx}", "src/a/foo.ts")).toBe(true);
  });

  test("double-star with brace: **/*.{ts,tsx} matches nested .tsx", () => {
    expect(matchGlob("**/*.{ts,tsx}", "src/a/bar.tsx")).toBe(true);
  });

  test("double-star with brace: **/*.{ts,tsx} does not match nested .js", () => {
    expect(matchGlob("**/*.{ts,tsx}", "src/a/baz.js")).toBe(false);
  });
});
