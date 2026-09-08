import { Linter } from "eslint";
import { describe, expect, test } from "bun:test";
import noContentPinTests from "../../../scripts/eslint-rules/no-content-pin-tests";

const lint = (code: string) =>
  new Linter({ configType: "flat" }).verify(code, {
    plugins: { corbits: { rules: { "no-content-pin-tests": noContentPinTests } } },
    rules: { "corbits/no-content-pin-tests": "error" },
  });

const flaggedIds = (code: string) => lint(code).map((message) => message.messageId);

describe("no-content-pin-tests", () => {
  test("flags literal wording pins on Bun.file-loaded assets", () => {
    expect(
      flaggedIds(
        [
          'const skill = await Bun.file(join(root, "skills/style/SKILL.md")).text();',
          'expect(skill).toContain("Prefer deletion over addition");',
          'expect(skill).not.toContain("spawn_agent");',
          'expect(skill).toBe("exact document text");',
          "expect(skill).toMatch(/You are \\w+Director/);",
        ].join("\n"),
      ),
    ).toEqual(["wordingPin", "wordingPin", "wordingPin", "wordingPin"]);
  });

  test("flags wording pins on members of assets parsed as JSON", () => {
    expect(
      flaggedIds(
        [
          'const manifest = await Bun.file("plugins/corbits-skills/manifest.json").json();',
          'expect(manifest.id).toBe("corbits-skills");',
          'expect(manifest.kind).toContain("command");',
        ].join("\n"),
      ),
    ).toEqual(["wordingPin", "wordingPin"]);
  });

  test("flags exact brand hex pins regardless of receiver", () => {
    expect(flaggedIds('expect(color("brand")).toBe("#f5933a");')).toEqual(["hexPin"]);
    expect(flaggedIds('expect(fg).toEqual("#7ea2c4");')).toEqual(["hexPin"]);
  });

  test("flags numeric pins on palette-named callees", () => {
    expect(flaggedIds('expect(color256("brand")).toBe(173);')).toEqual(["ansiIndexPin"]);
    expect(flaggedIds("expect(paletteIndex(role)).toEqual(74);")).toEqual(["ansiIndexPin"]);
  });

  test("keeps behavior-string assertions clean", () => {
    expect(
      flaggedIds(
        [
          'expect(groupChainSegmentsForDisplay("ls | head -5 && echo done")).toEqual([',
          '  "ls",',
          '  "head -5",',
          '  "echo done",',
          "]);",
          'expect(isShellNoOp("true")).toBe(true);',
          "expect(secondsFromMs(0)).toBe(0);",
          "expect(idx).toBeGreaterThanOrEqual(0);",
          "expect(cut.length).toBeLessThanOrEqual(20);",
          'expect(messages).toContain("outside the workspace");',
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("keeps runtime round-trips of non-document files clean", () => {
    expect(
      flaggedIds(
        [
          'const written = await Bun.file(join(cwd, "app.py")).text();',
          "expect(written).toBe(\"def greet():\\n    print('hello')\\n\");",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("keeps source-structure locks on .ts files clean", () => {
    expect(
      flaggedIds(
        [
          'const src = await Bun.file(new URL("./runner.ts", import.meta.url)).text();',
          'expect(src).toContain("standingPluginWarnings");',
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("keeps non-literal matcher arguments clean", () => {
    expect(
      flaggedIds(
        [
          "const before = await Bun.file(target).text();",
          "expect(await Bun.file(target).text()).toBe(before);",
          "expect(palette.diffAdded).toEqual(palette.success);",
          "expect(message).toContain(secret);",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("keeps range and contract checks on palette receivers clean", () => {
    expect(
      flaggedIds(
        [
          "expect(color256(role)).toBeLessThanOrEqual(255);",
          "expect(color(role)).toMatch(/^#[0-9a-fA-F]{6}$/);",
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});
