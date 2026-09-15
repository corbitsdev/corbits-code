// One shared dependency-free lexical ranker behind tool_search,
// search_agents, and skill_search. Exact name-token hits weigh most, then
// blob-token hits, then raw-substring matches (so "linear" finds
// mcp__linear__* even though it is not a whole token there).

export function tokenizeLexical(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

export interface LexicalFields {
  readonly name: string;
  readonly blob: string;
  readonly nameTokens: readonly string[];
  readonly blobTokens: ReadonlySet<string>;
}

export function lexicalFields(name: string, blob: string): LexicalFields {
  return {
    name,
    blob,
    nameTokens: tokenizeLexical(name),
    blobTokens: new Set(tokenizeLexical(blob)),
  };
}

export function scoreLexical(
  fields: LexicalFields,
  queryTokens: readonly string[],
  rawQuery: string,
): number {
  const name = fields.name.toLowerCase();
  const blob = fields.blob.toLowerCase();
  let total = 0;
  for (const token of queryTokens) {
    if (fields.nameTokens.includes(token)) total += 3;
    else if (fields.blobTokens.has(token)) total += 1;
    else if (name.includes(token)) total += 0.75;
    else if (blob.includes(token)) total += 0.25;
  }
  if (name.includes(rawQuery)) total += 1;
  return total;
}

// One shared rank→filter→sort→slice→map cut behind tool_search,
// search_agents, and skill_search. Per-surface scoring (and the agent
// description bonus) stays at each call site; only the cut is shared. The
// sort is score-descending and stable, so tied scores keep catalog order
// identically on every surface.
export function rankAndCut<T>(
  items: readonly T[],
  scoreItem: (item: T) => number,
  limit: number,
): T[] {
  return items
    .map((item) => ({ item, score: scoreItem(item) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.item);
}
