// Shared markdown frontmatter parsing for data-only plugins. Agents and
// commands both ship as markdown with optional YAML frontmatter, so the split
// logic lives here once rather than being duplicated (and drifting) per kind.

export interface ParsedMarkdown {
  // Parsed YAML frontmatter, an empty object when no block is present, or null
  // only when a block is present but malformed (callers skip the file).
  frontmatter: Record<string, unknown> | null;
  body: string;
}

// Strip a leading `---\n...\n---` YAML block. Returns { frontmatter, body }.
// No frontmatter block -> empty-object frontmatter (an agent/command can
// legitimately have none). A present-but-malformed block -> null frontmatter
// so the caller can skip the file rather than silently treat it as empty.
export function splitFrontmatter(raw: string): ParsedMarkdown {
  if (!raw.startsWith("---")) return { frontmatter: {}, body: raw.trim() };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: {}, body: raw.trim() };
  const yaml = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).trim();
  if (yaml.length === 0) return { frontmatter: {}, body };
  try {
    const parsed = Bun.YAML.parse(yaml);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { frontmatter: {}, body };
    }
    return { frontmatter: parsed as Record<string, unknown>, body };
  } catch {
    return { frontmatter: null, body };
  }
}
