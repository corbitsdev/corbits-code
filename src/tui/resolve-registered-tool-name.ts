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
  if (requested.length < 3 || requested.length % 2 === 0) return undefined;
  const name = requested.slice(0, (requested.length - 1) / 2);
  if (requested !== `${name}.${name}` || !isKnown(name)) return undefined;
  return name;
}
