const DEFAULT_PREFIX = "default.";

// Muse Spark emits `default.mcp__*` and duplicated `name.name`; catalog keys
// are the unprefixed names. Lookup-only — do not register aliases on the wire.
export function resolveRegisteredToolName(
  requested: string,
  isKnown: (name: string) => boolean,
): string | undefined {
  if (isKnown(requested)) return requested;

  if (requested.startsWith(DEFAULT_PREFIX)) {
    const stripped = requested.slice(DEFAULT_PREFIX.length);
    if (stripped.length === 0) return undefined;
    if (isKnown(stripped)) return stripped;
    const undoubled = undoubledKnownName(stripped, isKnown);
    if (undoubled !== undefined) return undoubled;
  }

  return undoubledKnownName(requested, isKnown);
}

function undoubledKnownName(
  requested: string,
  isKnown: (name: string) => boolean,
): string | undefined {
  const sep = requested.indexOf(".");
  if (sep <= 0) return undefined;
  const left = requested.slice(0, sep);
  const right = requested.slice(sep + 1);
  if (left.length === 0 || left !== right || !isKnown(left)) return undefined;
  return left;
}
