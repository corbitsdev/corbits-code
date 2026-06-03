export type StyledSegment = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  heading?: 1 | 2;
  bullet?: boolean;
  color?: string;
};

function parseSegments(text: string): StyledSegment[] {
  const segments: StyledSegment[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    // Match bold: **text** or __text__
    const boldMatch = remaining.match(/^\*\*(.+?)\*\*|^__(.+?)__/);
    if (boldMatch) {
      const content = boldMatch[1] || boldMatch[2] || "";
      if (content) {
        segments.push({ text: content, bold: true });
        remaining = remaining.slice(boldMatch[0].length);
        continue;
      }
    }

    // Match italic: *text* or _text_ (but not ** or __)
    const italicMatch = remaining.match(/^(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)|^(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/);
    if (italicMatch) {
      const content = italicMatch[1] || italicMatch[2] || "";
      if (content) {
        segments.push({ text: content, italic: true });
        remaining = remaining.slice(italicMatch[0].length);
        continue;
      }
    }

    // Match code: `text`
    const codeMatch = remaining.match(/^`(.+?)`/);
    if (codeMatch) {
      const content = codeMatch[1] || "";
      if (content) {
        segments.push({ text: content, code: true });
        remaining = remaining.slice(codeMatch[0].length);
        continue;
      }
    }

    // Match plain text up to next formatting marker
    const plainMatch = remaining.match(/^[^\*_`]+/);
    if (plainMatch && plainMatch[0]) {
      segments.push({ text: plainMatch[0] });
      remaining = remaining.slice(plainMatch[0].length);
      continue;
    }

    // Single character (shouldn't happen, but safety valve)
    segments.push({ text: remaining[0]! });
    remaining = remaining.slice(1);
  }

  return segments;
}

function applyFlag(segments: StyledSegment[], flag: Partial<StyledSegment>): StyledSegment[] {
  return segments.map((seg) => ({ ...seg, ...flag }));
}

function parseLine(line: string): StyledSegment[] {
  // Headings: # or ## followed by content. The marker is stripped so it never
  // appears in output; inline markdown inside the heading still applies.
  const headingMatch = line.match(/^(#{1,2})\s+(.+)$/);
  if (headingMatch) {
    const level = (headingMatch[1]?.length === 2 ? 2 : 1) as 1 | 2;
    const content = headingMatch[2] || "";
    return applyFlag(parseSegments(content), { heading: level });
  }

  // Bullet list items: optional indent, then - or * marker followed by content.
  // The raw marker is replaced by a "• " glyph; inline markdown in the content
  // still applies.
  const listMatch = line.match(/^(\s*)[-*]\s+(.+)$/);
  if (listMatch) {
    const indent = listMatch[1] || "";
    const content = listMatch[2] || "";
    const marker: StyledSegment = { text: indent + "• ", bullet: true };
    return [marker, ...applyFlag(parseSegments(content), { bullet: true })];
  }

  return parseSegments(line);
}

export function parseMarkdown(text: string): StyledSegment[][] {
  return text.split("\n").map(parseLine);
}
