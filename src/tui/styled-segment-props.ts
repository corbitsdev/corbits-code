import type { StyledSegment } from "./markdown-parser.js";
import { color } from "./theme.js";

export type InkSegmentProps = {
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  color?: string;
  dimColor?: boolean;
  backgroundColor?: string;
};

// Map parser flags to Ink text props and semantic theme roles. Fenced syntax
// highlighting sets seg.color explicitly; those values win over flag-derived colours.
export function inkPropsForSegment(seg: StyledSegment): InkSegmentProps {
  const props: InkSegmentProps = {};
  if (seg.bold) props.color = color("markdownStrong");
  if (seg.italic) props.italic = true;
  if (seg.strikethrough) props.strikethrough = true;
  if (seg.heading !== undefined) props.color = color("markdownHeading");
  if (seg.link) {
    props.underline = true;
    props.color = color("markdownLink");
  }
  if (seg.blockquote) {
    props.italic = true;
    props.color = color("markdownBlockquote");
  }
  if (seg.rule) props.color = color("muted");
  if (seg.bullet && /^\s*(•|\d+\.)/.test(seg.text)) props.color = color("muted");
  if (seg.code && seg.color === undefined) props.color = color("markdownCode");
  if (seg.italic && !seg.blockquote && props.color === undefined) {
    props.color = color("markdownEmphasis");
  }
  if (seg.color !== undefined) props.color = seg.color;
  if (seg.dim) props.dimColor = true;
  if (seg.backgroundColor !== undefined) props.backgroundColor = seg.backgroundColor;
  return props;
}