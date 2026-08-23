// Minimal, dependency-free HTML -> text/markdown conversion. Good enough for
// web_fetch's purpose (feeding page content to the model) without pulling in
// a DOM/parser dependency; not a general-purpose renderer.

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(parseInt(dec, 10)));
}

function stripTagsAndScripts(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}

export function htmlToText(html: string): string {
  const cleaned = stripTagsAndScripts(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(cleaned)
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

// Best-effort structural markdown: headings, bold/italic, links, list items.
// Anything not recognized falls through to plain text extraction.
export function htmlToMarkdown(html: string): string {
  let working = stripTagsAndScripts(html);
  working = working
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => {
      return `\n${"#".repeat(Number(level))} ${htmlToText(inner)}\n`;
    })
    .replace(
      /<a\s[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (_m, href: string, inner: string) => {
        const text = htmlToText(inner);
        return text.length > 0 ? `[${text}](${href})` : href;
      },
    )
    .replace(
      /<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi,
      (_m, _tag: string, inner: string) => `**${htmlToText(inner)}**`,
    )
    .replace(
      /<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi,
      (_m, _tag: string, inner: string) => `_${htmlToText(inner)}_`,
    )
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner: string) => `\`${htmlToText(inner)}\``)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => `\n- ${htmlToText(inner)}`)
    .replace(/<\/(p|div|tr|table|ul|ol)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");
  const text = decodeEntities(working.replace(/<[^>]+>/g, ""));
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .trim();
}
