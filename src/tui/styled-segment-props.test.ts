import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { StyledSegment } from "./markdown-parser.js";
import { inkPropsForSegment } from "./styled-segment-props.js";
import { color, color256, palette, type SemanticRole } from "./theme.js";

const originalColorterm = process.env.COLORTERM;

function segmentFor(props: Partial<StyledSegment>): StyledSegment {
  return { text: "sample", ...props };
}

describe("inkPropsForSegment truecolor fallback", () => {
  beforeEach(() => {
    delete process.env.COLORTERM;
  });

  afterEach(() => {
    if (originalColorterm === undefined) delete process.env.COLORTERM;
    else process.env.COLORTERM = originalColorterm;
  });

  test("emits hex colours when the terminal supports truecolor", () => {
    process.env.COLORTERM = "truecolor";
    const seg = segmentFor({ bold: true });
    expect(inkPropsForSegment(seg).color).toBe(palette.markdownStrong.hex);
  });

  test("falls back to the 256-color value on a non-truecolor terminal", () => {
    const roles: { seg: StyledSegment; role: SemanticRole }[] = [
      { seg: segmentFor({ bold: true }), role: "markdownStrong" },
      { seg: segmentFor({ heading: 1 }), role: "markdownHeading" },
      { seg: segmentFor({ link: true }), role: "markdownLink" },
      { seg: segmentFor({ blockquote: true }), role: "markdownBlockquote" },
      { seg: segmentFor({ rule: true }), role: "muted" },
      { seg: segmentFor({ code: true }), role: "markdownCode" },
      { seg: segmentFor({ italic: true }), role: "markdownEmphasis" },
    ];

    for (const { seg, role } of roles) {
      const props = inkPropsForSegment(seg);
      expect(props.color).toBe(`ansi256(${color256(role)})`);
      expect(props.color).toBe(color(role));
    }
  });

  test("does not override an explicit segment color with a role fallback", () => {
    const seg = segmentFor({ bold: true, color: "#123456" });
    expect(inkPropsForSegment(seg).color).toBe("#123456");
  });
});
