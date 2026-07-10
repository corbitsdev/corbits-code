import { test, expect } from "bun:test";
import { inkPropsForSegment } from "../../../src/tui/styled-segment-props.js";
import { color } from "../../../src/tui/theme.js";

test("maps markdown flags to semantic theme roles", () => {
  expect(inkPropsForSegment({ text: "h", heading: 2 }).color).toBe(color("markdownHeading"));
  expect(inkPropsForSegment({ text: "l", link: true }).color).toBe(color("markdownLink"));
  expect(inkPropsForSegment({ text: "l", link: true }).underline).toBe(true);
  expect(inkPropsForSegment({ text: "c", code: true }).color).toBe(color("markdownCode"));
  expect(inkPropsForSegment({ text: "b", bold: true }).color).toBe(color("markdownStrong"));
  expect(inkPropsForSegment({ text: "i", italic: true }).color).toBe(color("markdownEmphasis"));
  expect(inkPropsForSegment({ text: "q", blockquote: true }).color).toBe(color("markdownBlockquote"));
});

test("explicit segment color overrides flag-derived markdown colours", () => {
  const syntax = color("syntaxKeyword");
  expect(inkPropsForSegment({ text: "kw", code: true, color: syntax }).color).toBe(syntax);
});