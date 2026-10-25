// One shared dependency-free lexical ranker behind tool_search,
// search_agents, and skill_search. Exact name-token hits weigh most, then
// name tokens that match across a trailing plural "s" (so "issue" finds
// list_issues while the spelling the query uses still wins ties), then
// blob-token hits, then a raw name substring (so "linear" finds
// mcp__linear__* even though it is not a whole token there), then a raw blob
// substring. Parameter name and description tokens (tool_search only) weigh
// less than a name substring and only boost an item that already matches by
// name or blob: a filter makes the tool that carries it rank higher, but a
// query that matches nothing except parameter text stays a miss, so
// tool_search still waits for servers that are connecting.
export function tokenizeLexical(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

// Folding also merges real word pairs such as "news" and "new", so it stays
// on names: in descriptions, a common word like "new" would turn a miss into
// a false hit. Three-letter words keep their "s", so "its" never becomes "it".
function foldPlural(token: string): string {
  return token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token;
}

// Under exact (3); 3 + this clears TOOL_SEARCH_SCORE_RATIO * 6 ("issue list").
const FOLDED_NAME_TOKEN_SCORE = 2.5;

export interface LexicalFields {
  readonly name: string;
  readonly blob: string;
  readonly nameTokens: readonly string[];
  readonly foldedNameTokens: readonly string[];
  readonly blobTokens: ReadonlySet<string>;
  readonly paramNameTokens: ReadonlySet<string>;
  readonly paramBlobTokens: ReadonlySet<string>;
}

interface LexicalParams {
  readonly names: readonly string[];
  readonly blob: string;
}

export const NO_LEXICAL_PARAMS: LexicalParams = { names: [], blob: "" };

// JSON Schema keys are usually camelCase, and an undescribed flag such as
// `includeArchived` carries its word only inside the key.
function splitCamelCase(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2");
}

export function lexicalFields(
  name: string,
  blob: string,
  params: LexicalParams,
): LexicalFields {
  const nameTokens = tokenizeLexical(name);
  return {
    name,
    blob,
    nameTokens,
    foldedNameTokens: nameTokens.map(foldPlural),
    blobTokens: new Set(tokenizeLexical(blob)),
    paramNameTokens: new Set(
      tokenizeLexical(params.names.map(splitCamelCase).join(" ")),
    ),
    paramBlobTokens: new Set(tokenizeLexical(params.blob)),
  };
}

function directTokenScore(
  fields: LexicalFields,
  name: string,
  blob: string,
  token: string,
): number {
  if (fields.nameTokens.includes(token)) return 3;
  if (fields.foldedNameTokens.includes(foldPlural(token))) {
    return FOLDED_NAME_TOKEN_SCORE;
  }
  if (fields.blobTokens.has(token)) return 1;
  if (name.includes(token)) return 0.75;
  if (blob.includes(token)) return 0.25;
  return 0;
}

function paramTokenScore(fields: LexicalFields, token: string): number {
  if (fields.paramNameTokens.has(token)) return 0.5;
  if (fields.paramBlobTokens.has(token)) return 0.25;
  return 0;
}

export function scoreLexical(
  fields: LexicalFields,
  queryTokens: readonly string[],
  rawQuery: string,
): number {
  const name = fields.name.toLowerCase();
  const blob = fields.blob.toLowerCase();
  let matched = name.includes(rawQuery) ? 1 : 0;
  let total = matched;
  // A model repeats a word because its sentence needs it ("release ID or
  // release slug"), not to weight it; counting each copy multiplies the
  // bonus for every tool that matches that one word. "issue" and "issues"
  // are one word, scored as whichever spelling matches better. The merge
  // applies on every tier, so an unrelated pair like "new" and "news" also
  // counts once against a description; that is accepted.
  const words = new Map<string, string[]>();
  for (const token of new Set(queryTokens)) {
    const folded = foldPlural(token);
    const spellings = words.get(folded);
    if (spellings === undefined) words.set(folded, [token]);
    else spellings.push(token);
  }
  for (const spellings of words.values()) {
    const direct = Math.max(
      ...spellings.map((token) => directTokenScore(fields, name, blob, token)),
    );
    const param = Math.max(
      ...spellings.map((token) => paramTokenScore(fields, token)),
    );
    matched += direct;
    total += Math.max(direct, param);
  }
  return matched > 0 ? total : 0;
}

// One shared rank→filter→sort→slice→map cut behind tool_search,
// search_agents, and skill_search. Per-surface scoring (and the agent
// description bonus) stays at each call site; only the cut is shared. The
// sort is score-descending and stable, so tied scores keep catalog order
// identically on every surface. `minRatio` (0–1) drops scores below
// top * minRatio before the limit slice, so a specific query keeps the peak
// cluster instead of filling the N cap with weak cousins.
export function rankAndCut<T>(
  items: readonly T[],
  scoreItem: (item: T) => number,
  limit: number,
  minRatio?: number,
): T[] {
  const ranked = items
    .map((item) => ({ item, score: scoreItem(item) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  const top = ranked[0]?.score ?? 0;
  const floor = minRatio === undefined || top === 0 ? 0 : top * minRatio;
  return ranked
    .filter((entry) => entry.score >= floor)
    .slice(0, limit)
    .map((entry) => entry.item);
}
