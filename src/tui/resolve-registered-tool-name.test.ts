import { describe, expect, test } from "bun:test";
import { resolveRegisteredToolName } from "./resolve-registered-tool-name.js";

const catalog = "mcp__linear__get_release";
const known = new Set([catalog, "read_file"]);
const isKnown = (name: string) => known.has(name);

describe("resolveRegisteredToolName", () => {
  test("returns an exact catalog hit", () => {
    expect(resolveRegisteredToolName(catalog, isKnown)).toBe(catalog);
  });

  test("strips a leading default. prefix onto a known tool", () => {
    expect(resolveRegisteredToolName(`default.${catalog}`, isKnown)).toBe(
      catalog,
    );
  });

  test("resolves a duplicated name.name suffix when both halves are known", () => {
    expect(resolveRegisteredToolName(`${catalog}.${catalog}`, isKnown)).toBe(
      catalog,
    );
  });

  test("strips default. then a duplicated suffix", () => {
    expect(
      resolveRegisteredToolName(`default.${catalog}.${catalog}`, isKnown),
    ).toBe(catalog);
  });

  test("bare default stays unknown", () => {
    expect(resolveRegisteredToolName("default", isKnown)).toBeUndefined();
  });

  test("default. with nothing after it stays unknown", () => {
    expect(resolveRegisteredToolName("default.", isKnown)).toBeUndefined();
  });

  test("a prefix onto an unknown name stays unknown", () => {
    expect(
      resolveRegisteredToolName("default.mcp__linear__missing", isKnown),
    ).toBeUndefined();
  });

  test("unequal halves stay unknown even if one half is known", () => {
    expect(
      resolveRegisteredToolName(`${catalog}.read_file`, isKnown),
    ).toBeUndefined();
  });

  test("equal halves that are not a known tool stay unknown", () => {
    expect(resolveRegisteredToolName("ghost.ghost", isKnown)).toBeUndefined();
  });

  test("resolves a doubled catalog name that itself contains a dot", () => {
    const dotted = "mcp__foo.bar__baz";
    const isDottedKnown = (name: string) => name === dotted;
    expect(
      resolveRegisteredToolName(`${dotted}.${dotted}`, isDottedKnown),
    ).toBe(dotted);
  });
});
