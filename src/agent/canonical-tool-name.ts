const DEFAULT_PREFIX = "default.";

// Muse Spark emits `default.<name>` and duplicated `<name>.<name>`. Dispatch
// already strips those onto catalog keys; classify, grants, and the execution
// cache must use the same name so an alias cannot force a second ask/deny.
export function canonicalToolName(requested: string): string {
  let name = requested;
  if (name.startsWith(DEFAULT_PREFIX)) {
    const stripped = name.slice(DEFAULT_PREFIX.length);
    if (stripped.length > 0) name = stripped;
  }
  return undoubledName(name) ?? name;
}

function undoubledName(requested: string): string | undefined {
  if (requested.length < 3 || requested.length % 2 === 0) return undefined;
  const name = requested.slice(0, (requested.length - 1) / 2);
  if (requested !== `${name}.${name}`) return undefined;
  return name;
}
