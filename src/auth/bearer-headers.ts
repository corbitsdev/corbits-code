export interface BearerToken {
  readonly access: string;
}

export function bearerHeaders(
  token: BearerToken,
  extra: Record<string, string> = {},
): Record<string, string> {
  return { authorization: `Bearer ${token.access}`, ...extra };
}
