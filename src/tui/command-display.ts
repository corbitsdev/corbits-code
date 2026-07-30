// Display-only helpers for the chained-command approval modal. These never
// influence classification, grant scopes, or what actually executes — only
// how an already-sanitized command string is grouped and truncated on screen.
// Splitting logic used for approval/classification lives in
// src/permission/command.ts and is intentionally not reused here: this
// grouping is coarser (pipes stay inline) and must never feed back into a
// security decision.

// Mirrors the top-level boundary rules in splitChainedCommand (quote- and
// paren-aware, && / || / ; / newline are chain boundaries) but treats a
// single "|" as part of the current segment instead of a boundary, so a pipe
// stage never shows up as its own meaningless numbered item.
export function groupChainSegmentsForDisplay(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | "`" | null = null;
  let parenDepth = 0;

  const push = (): void => {
    const trimmed = current.trim();
    current = "";
    if (trimmed.length > 0) segments.push(trimmed);
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string;

    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }

    if (ch === "(") {
      parenDepth++;
      current += ch;
      continue;
    }
    if (ch === ")") {
      if (parenDepth > 0) parenDepth--;
      current += ch;
      continue;
    }
    if (parenDepth > 0) {
      current += ch;
      continue;
    }

    const next = command[i + 1];
    if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
      push();
      i++;
      continue;
    }
    if (ch === ";" || ch === "\n") {
      push();
      continue;
    }
    current += ch;
  }
  push();
  return segments;
}

// Truncate to `max` characters keeping both the head and tail, so a set of
// strings that share a long common prefix (e.g. persistent Allow options that
// differ only in their trailing grant note) stay visually distinguishable
// instead of all clipping at the same point.
export function middleEllipsis(text: string, max: number): string {
  if (text.length <= max || max <= 1) return text.length <= max ? text : text.slice(0, max);
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}
