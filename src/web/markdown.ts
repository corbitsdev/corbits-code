// Minimal HTML-to-markdown converter. Strips script, style, nav, and other
// non-content tags, then maps common semantic tags to markdown equivalents.
// This is intentionally simple — it does not parse full HTML (no DOM), but
// handles the common cases well enough for web_fetch output.

const BLOCKED_TAGS = new Set([
  "script",
  "style",
  "nav",
  "header",
  "footer",
  "aside",
  "iframe",
  "canvas",
  "svg",
  "noscript",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "label",
]);

function removeBlockedTags(html: string): string {
  let text = html;
  for (const tag of BLOCKED_TAGS) {
    const open = new RegExp(`<${tag}\\b[^>]*>`, "gi");
    const close = new RegExp(`</${tag}>`, "gi");
    // Remove the tag and everything between matching open/close.
    // This is a best-effort strip, not a full parser.
    let start = text.search(open);
    while (start !== -1) {
      const afterOpen = text.indexOf(">", start) + 1;
      const end = text.search(close);
      if (end !== -1 && end >= afterOpen) {
        text = text.slice(0, start) + text.slice(end + (`</${tag}>`).length);
      } else {
        // No closing tag; just remove the opening tag.
        text = text.slice(0, start) + text.slice(afterOpen);
      }
      start = text.search(open);
    }
  }
  return text;
}

function collapseWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function htmlToMarkdown(html: string): string {
  let text = removeBlockedTags(html);

  // Headings
  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_m, g1) => `\n# ${stripInlineTags(g1)}\n`);
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_m, g1) => `\n## ${stripInlineTags(g1)}\n`);
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_m, g1) => `\n### ${stripInlineTags(g1)}\n`);
  text = text.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, (_m, g1) => `\n#### ${stripInlineTags(g1)}\n`);
  text = text.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, (_m, g1) => `\n##### ${stripInlineTags(g1)}\n`);
  text = text.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, (_m, g1) => `\n###### ${stripInlineTags(g1)}\n`);

  // Lists
  text = text.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_m, g1) => convertListItems(g1, "- "));
  text = text.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_m, g1) => convertListItems(g1, "1. "));

  // Code blocks
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, g1) => `\n\`\`\`\n${stripInlineTags(g1)}\n\`\`\`\n`);

  // Inline elements
  text = text.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, (_m, g1) => `**${g1}**`);
  text = text.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, (_m, g1) => `**${g1}**`);
  text = text.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, (_m, g1) => `*${g1}*`);
  text = text.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, (_m, g1) => `*${g1}*`);
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, g1) => `\`${g1}\``);
  text = text.replace(/<a\b[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, label) => `[${stripInlineTags(label)}](${href})`);
  text = text.replace(/<img\b[^>]+src="([^"]*)"[^>]*>/gi, (_m, src) => `![image](${src})`);

  // Paragraphs and line breaks
  text = text.replace(/<p[^>]*>/gi, "\n\n");
  text = text.replace(/<\/p>/gi, "");
  text = text.replace(/<br\s*\/?>/gi, "\n");

  // Strip all remaining tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode common entities
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)));
  text = text.replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
  text = text.replace(/&nbsp;/g, " ");

  return collapseWhitespace(text);
}

function stripInlineTags(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function convertListItems(html: string, prefix: string): string {
  const items: string[] = [];
  const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let match: RegExpExecArray | null;
  while ((match = liRegex.exec(html)) !== null) {
    items.push(`${prefix}${stripInlineTags(match[1] ?? "").trim()}`);
  }
  return items.length > 0 ? `\n${items.join("\n")}\n` : "";
}
