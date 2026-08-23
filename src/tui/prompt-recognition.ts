/**
 * Prompt token recognition: leading slash commands and @mentions.
 *
 * Bare skill/agent names are never highlighted. Orange is reserved for a
 * leading `/command` (the `/name` only) and `@mention` tokens anywhere.
 */

export interface PromptRecognitionNames {
  readonly commandNames: readonly string[];
}

/** Live command-name supplier. Skills and agents are not part of this surface. */
export type PromptRecognitionSource = () => PromptRecognitionNames;

export interface PromptHighlightSpan {
  readonly start: number;
  readonly end: number;
}

export interface PromptRecognitionMatcher {
  readonly commandPattern: RegExp | null;
}

/** `@mention` tokens anywhere: quoted (`@"name"`) or a run of non-whitespace. */
const MENTION_RE = /@("([^"]+)"|\S+)/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeCommandName(name: string): string {
  const trimmed = name.trim();
  return trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
}

/**
 * Build a matcher for registered slash-command names. Empty input yields
 * `null`; @mentions still paint through `resolvePromptHighlightSpans`.
 */
export function buildPromptRecognitionMatcher(
  commandNames: readonly string[],
): PromptRecognitionMatcher | null {
  const unique = [
    ...new Set(commandNames.map(normalizeCommandName).filter((name) => name.length > 0)),
  ];
  if (unique.length === 0) return null;
  const sorted = unique.sort((a, b) => b.length - a.length);
  const body = sorted.map(escapeRegExp).join("|");
  return {
    commandPattern: new RegExp(`^/(${body})(?![A-Za-z0-9_-])`, "i"),
  };
}

let cachedSource: PromptRecognitionSource | undefined;
let cachedKey: string | undefined;
let cachedMatcher: PromptRecognitionMatcher | null = null;

export function resolvePromptRecognitionMatcher(
  source: PromptRecognitionSource,
): PromptRecognitionMatcher | null {
  const names = source().commandNames;
  const key = names.join("\0");
  if (cachedSource === source && cachedKey === key) return cachedMatcher;
  cachedSource = source;
  cachedKey = key;
  cachedMatcher = buildPromptRecognitionMatcher(names);
  return cachedMatcher;
}

function mentionSpans(text: string): PromptHighlightSpan[] {
  const spans: PromptHighlightSpan[] = [];
  MENTION_RE.lastIndex = 0;
  let match = MENTION_RE.exec(text);
  while (match !== null) {
    const start = match.index;
    spans.push({ start, end: start + match[0].length });
    match = MENTION_RE.exec(text);
  }
  return spans;
}

export function resolvePromptHighlightSpans(
  text: string,
  matcher: PromptRecognitionMatcher | null,
): PromptHighlightSpan[] {
  const spans: PromptHighlightSpan[] = [];
  const commandPattern = matcher?.commandPattern;
  if (commandPattern !== undefined && commandPattern !== null) {
    commandPattern.lastIndex = 0;
    const command = commandPattern.exec(text);
    if (command !== null) {
      spans.push({ start: 0, end: command[0].length });
    }
  }
  spans.push(...mentionSpans(text));
  return spans.sort((a, b) => a.start - b.start);
}
