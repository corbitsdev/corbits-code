import { describe, expect, test } from "bun:test";
import { canonicalToolOutputUri, normalizeToolOutputUri } from "./tool-output-uri.js";

describe("normalizeToolOutputUri", () => {
  test("leaves canonical three-slash URIs unchanged", () => {
    expect(normalizeToolOutputUri("tool-output:///abc123")).toBe("tool-output:///abc123");
  });

  test("fixes tool-output:/id", () => {
    expect(normalizeToolOutputUri("tool-output:/abc123")).toBe("tool-output:///abc123");
  });

  test("fixes tool-output://CallId mistaken as hostname", () => {
    expect(normalizeToolOutputUri("tool-output://AbC")).toBe("tool-output:///AbC");
  });

  test("passes through normal paths", () => {
    expect(normalizeToolOutputUri("src/foo.ts")).toBe("src/foo.ts");
  });
});

describe("canonicalToolOutputUri", () => {
  test("returns canonical three-slash URIs", () => {
    expect(canonicalToolOutputUri("tool-output:///abc")).toBe("tool-output:///abc");
    expect(canonicalToolOutputUri("tool-output:/abc")).toBe("tool-output:///abc");
  });

  test("returns undefined for empty or non-tool paths", () => {
    expect(canonicalToolOutputUri("tool-output:")).toBeUndefined();
    expect(canonicalToolOutputUri("src/foo.ts")).toBeUndefined();
  });
});