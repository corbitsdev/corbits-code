// The common-language build (~40 grammars) instead of the full ~190-grammar
// bundle: it keeps startup and bundle size in check, and unknown languages
// already fall back to plain code.
import hljs from "highlight.js/lib/common";
import type { StyledSegment } from "./markdown-parser.js";
import { color, type SemanticRole } from "./semantic-theme.js";

// Map highlight.js scope classes to the semantic syntax palette. hljs emits a
// class attribute whose first token is prefixed `hljs-` and whose optional
// second token names a sub-scope (`title function_`, `title class_`). We look at
// the whole attribute so those sub-scopes route to the right role.
function roleForClass(cls: string): SemanticRole | undefined {
  if (cls.includes("comment") || cls.includes("quote")) return "syntaxComment";
  if (
    cls.includes("string") ||
    cls.includes("regexp") ||
    cls.includes("char") ||
    cls.includes("symbol")
  ) {
    return "syntaxString";
  }
  if (cls.includes("number")) return "syntaxNumber";
  if (cls.includes("function")) return "syntaxFunction";
  if (cls.includes("class") || cls.includes("type") || cls.includes("built_in"))
    return "syntaxType";
  if (cls.includes("keyword") || cls.includes("literal") || cls.includes("meta"))
    return "syntaxKeyword";
  if (cls.includes("operator")) return "syntaxOperator";
  if (cls.includes("punctuation")) return "syntaxPunctuation";
  if (
    cls.includes("variable") ||
    cls.includes("attr") ||
    cls.includes("property") ||
    cls.includes("params") ||
    cls.includes("title") ||
    cls.includes("selector")
  ) {
    return "syntaxVariable";
  }
  return undefined;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#x27": "'",
  "#39": "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x27|#39|amp|lt|gt|quot);/g, (_, name: string) => ENTITIES[name] ?? _);
}

interface Token { text: string; role: SemanticRole | undefined }

// hljs output is a well-formed subset of HTML: text, entities, and `<span
// class="...">` wrappers that may nest. Walk it once, keeping a stack of the
// active scope roles so the innermost recognized scope colours each text run.
function tokenizeHljsHtml(html: string): Token[] {
  const tokens: Token[] = [];
  const stack: (SemanticRole | undefined)[] = [];
  const tagRe = /<span class="([^"]*)">|<\/span>/g;
  let last = 0;

  const pushText = (raw: string) => {
    if (raw.length === 0) return;
    const role = stack.length > 0 ? stack[stack.length - 1] : undefined;
    tokens.push({ text: decodeEntities(raw), role });
  };

  for (let m = tagRe.exec(html); m !== null; m = tagRe.exec(html)) {
    pushText(html.slice(last, m.index));
    last = tagRe.lastIndex;
    if (m[1] !== undefined) {
      const role = roleForClass(m[1]);
      stack.push(role ?? (stack.length > 0 ? stack[stack.length - 1] : undefined));
    } else {
      stack.pop();
    }
  }
  pushText(html.slice(last));

  return tokens;
}

// Break a flat token stream into visual lines, splitting any token that spans a
// newline so each rendered line is a self-contained segment array.
function tokensToLines(tokens: Token[]): StyledSegment[][] {
  const lines: StyledSegment[][] = [[]];
  for (const token of tokens) {
    const parts = token.text.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part.length === 0) return;
      const seg: StyledSegment = { text: part, code: true };
      if (token.role !== undefined) seg.color = color(token.role);
      lines[lines.length - 1]!.push(seg);
    });
  }
  return lines;
}

function plainLines(code: string): StyledSegment[][] {
  return code.split("\n").map((line) => (line.length === 0 ? [] : [{ text: line, code: true }]));
}

const cache = new Map<string, StyledSegment[][]>();
const CACHE_LIMIT = 256;

function cached(key: string, compute: () => StyledSegment[][]): StyledSegment[][] {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const value = compute();
  // Streaming re-highlights a growing block every drain, minting a fresh key
  // each time; bound the map so those transient entries cannot accumulate.
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
  return value;
}

// Highlight a fenced block's body into styled lines. Unknown or absent languages
// fall back to plain muted code. `width` participates in the cache key so cached
// output never leaks across a resize even though highlighting itself is
// width-independent.
export function highlightCode(
  code: string,
  language: string | undefined,
  width: number,
): StyledSegment[][] {
  const lang =
    language !== undefined && hljs.getLanguage(language) !== undefined ? language : undefined;
  const key = `${width}\x1f${lang ?? ""}\x1f${code}`;
  return cached(key, () => {
    if (lang === undefined) return plainLines(code);
    const html = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    return tokensToLines(tokenizeHljsHtml(html));
  });
}
