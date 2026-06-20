import { describe, expect, test } from "bun:test";
import { normalizeToolOutputUri } from "./tool-output-uri.js";

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