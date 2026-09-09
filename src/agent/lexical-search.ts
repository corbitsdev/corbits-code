// Shared lexical ranker for the agent-side search tools (tool_search,
// skill_search, search_agents). Each used to carry its own copy of the
// tokenizer and scoring weights; keeping them here means a ranking change
// (weight tuning, tokenizer tweaks) lands in one place instead of drifting
// across three copies.

/** Lowercase alphanumeric tokens; any other character splits tokens. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** The two scored surfaces of a searchable document. */
export interface LexicalSearchFields {
  /** Short identifier — exact token hits weigh most (tool name, skill name, agent id). */
  name: string;
  /** Body text — token hits weigh less (description, role text). */
  text: string;
}

/**
 * Score one document against a query. Exact name-token hits weigh most (3),
 * then text-token hits (1), then raw-substring matches (0.75 in the name,
 * 0.25 in the text — so "linear" finds mcp__linear__* even though it is not
 * a whole token there), plus a raw-query hit in the name (+1). `extra` lets a
 * caller add a document-specific term without forking the weights.
 */
export function scoreLexicalMatch(
  fields: LexicalSearchFields,
  queryTokens: readonly string[],
  rawQuery: string,
  extra = 0,
): number {
  const nameTokens = tokenize(fields.name);
  const textTokens = new Set(tokenize(fields.text));
  const nameLower = fields.name.toLowerCase();
  const textLower = fields.text.toLowerCase();
  let total = 0;
  for (const token of queryTokens) {
    if (nameTokens.includes(token)) total += 3;
    else if (textTokens.has(token)) total += 1;
    else if (nameLower.includes(token)) total += 0.75;
    else if (textLower.includes(token)) total += 0.25;
  }
  if (nameLower.includes(rawQuery)) total += 1;
  return total + extra;
}

/**
 * Rank `items` against a query: score each document, drop zero-score hits,
 * order by descending score (stable — ties keep input order), and cap at
 * `limit`. Returns [] for an empty or whitespace-only query (no tokens to
 * match), so callers that treat an empty query as "return everything" (agent
 * search) keep that branch on their side. `extra` lets a caller add a
 * per-item scoring term without forking the weights.
 */
export function rankLexicalMatches<T>(
  items: readonly T[],
  fieldsFor: (item: T) => LexicalSearchFields,
  query: string,
  limit: number,
  extra?: (item: T, rawQuery: string) => number,
): T[] {
  const rawQuery = query.toLowerCase().trim();
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];
  return items
    .map((item) => ({
      item,
      score: scoreLexicalMatch(
        fieldsFor(item),
        queryTokens,
        rawQuery,
        extra?.(item, rawQuery) ?? 0,
      ),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.item);
}
