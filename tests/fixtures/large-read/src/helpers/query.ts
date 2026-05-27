export function parseQuery(url: string): { base: string; params: Record<string, string> } {
  const [base, search] = url.split("?");
  const params: Record<string, string> = {};
  if (search) {
    for (const pair of search.split("&")) {
      const [k, v] = pair.split("=");
      if (k) params[k] = v ?? "";
    }
  }
  return { base: base ?? url, params };
}
