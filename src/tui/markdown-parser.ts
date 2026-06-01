export type StyledSegment = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
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

export function parseMarkdown(text: string): StyledSegment[][] {
  return text.split("\n").map((line) => {
    // Handle list items
    const listMatch = line.match(/^(\s*)[-*]\s+(.+)$/);
    if (listMatch) {
      const indent = listMatch[1] || "";
      const content = listMatch[2] || "";
      const indentSegment: StyledSegment = { text: indent + "• " };
      return [indentSegment, ...parseSegments(content)];
    }

    return parseSegments(line);
  });
}
