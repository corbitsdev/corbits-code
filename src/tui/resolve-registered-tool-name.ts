import { canonicalToolName } from "../agent/canonical-tool-name.js";

// Muse Spark emits `default.mcp__*` and duplicated `name.name`; catalog keys
// are the unprefixed names. Lookup-only — do not register aliases on the wire.
export function resolveRegisteredToolName(
  requested: string,
  isKnown: (name: string) => boolean,
): string | undefined {
  if (isKnown(requested)) return requested;
  const canonical = canonicalToolName(requested);
  if (canonical !== requested && isKnown(canonical)) return canonical;
  return undefined;
}
