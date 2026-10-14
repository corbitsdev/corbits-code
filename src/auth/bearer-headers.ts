export interface BearerToken {
  readonly access: string;
}

// The one header every provider carries on an inference request; provider
// extras (account ids, client identifiers) ride alongside via the spread.
export function bearerHeaders(
  token: BearerToken,
  extra: Record<string, string> = {},
): Record<string, string> {
  return { authorization: `Bearer ${token.access}`, ...extra };
}
