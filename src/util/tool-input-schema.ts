/**
 * Serves a tool's inputSchema from its declared arktype args type so the type
 * stays the single source of truth for what the model sees. `dialect: null`
 * drops the `$schema` doc key the wire shape is validated against without.
 */
export function toolInputSchema(argsType: {
  toJsonSchema(options?: { dialect: string | null }): unknown;
}): Record<string, unknown> {
  return argsType.toJsonSchema({ dialect: null }) as Record<string, unknown>;
}
