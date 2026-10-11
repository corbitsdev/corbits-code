/**
 * Neutral `/connect <kind> [profile]` scope shared by the slash command and
 * reconnect-recovery state; lives outside commands/ and runner/ so neither
 * reaches into the other.
 */

export interface ReconnectScope {
  readonly kind: string;
  readonly profile: string;
}

/** Parse `/connect <kind> [profile]` args; bare kind reconnects `default`. */
export function parseConnectScopeArgs(
  rawArgs: string,
): ReconnectScope | undefined {
  const parts = rawArgs
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  if (parts.length === 0 || parts.length > 2) return undefined;
  const kind = parts[0] ?? "";
  const profile = parts.length === 2 ? (parts[1] ?? "") : "default";
  if (kind.length === 0 || profile.length === 0) return undefined;
  if (!/^[a-z0-9_-]+$/i.test(kind)) return undefined;
  if (!/^[a-z0-9_-]+$/i.test(profile)) return undefined;
  return { kind, profile };
}

/** Build the descriptor the terminal copy + affordance share: one spelling. */
export function buildReconnectCommand(scope: ReconnectScope): string {
  return `/connect ${scope.kind} ${scope.profile}`;
}
