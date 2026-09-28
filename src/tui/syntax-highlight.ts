/**
 * Fenced-code styling for the synchronous markdown model.
 *
 * Tree-sitter highlighting is asynchronous, so the synchronous StyledSegment
 * model cannot colour tokens. Live transcript colour belongs to the native
 * MarkdownRenderable/CodeRenderable path with transcriptSyntaxStyle() over the
 * bundled tree-sitter grammars (javascript, typescript, markdown, zig). This
 * module keeps the legacy path's geometry with plain segments.
 */
import type { StyledSegment } from "./markdown-parser.js";

function plainLines(code: string): StyledSegment[][] {
  return code
    .split("\n")
    .map((text) => (text.length === 0 ? [] : [{ text, code: true }]));
}

const codeCache = new Map<string, StyledSegment[][]>();
const CODE_CACHE_LIMIT = 256;

function cached(
  key: string,
  build: () => StyledSegment[][],
): StyledSegment[][] {
  const hit = codeCache.get(key);
  if (hit !== undefined) return hit;
  const built = build();
  codeCache.set(key, built);
  if (codeCache.size > CODE_CACHE_LIMIT) {
    const oldest = codeCache.keys().next();
    if (!oldest.done) codeCache.delete(oldest.value);
  }
  return built;
}

/**
 * Styled lines for a fenced body in the synchronous model. Colour is owned by
 * the native renderer, so every language is plain here. Width remains in the
 * cache key to preserve the parser-facing API's resize semantics.
 */
export function highlightCode(
  code: string,
  _language: string | undefined,
  width?: number,
): StyledSegment[][] {
  return cached(`${width ?? ""}\x1f${code}`, () => plainLines(code));
}
