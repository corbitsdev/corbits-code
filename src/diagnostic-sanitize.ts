import { scrubSecretShapedContent } from "./plugins/tool-result-secret-scrub.js";
import { stripTerminalControlSequences } from "./util/control-char-strip.js";

export function sanitizeDiagnosticText(
  text: string,
  configuredSecrets: readonly (string | undefined)[],
): string {
  let sanitized = stripTerminalControlSequences(text);
  for (const secret of configuredSecrets) {
    if (secret !== undefined && secret.length > 0)
      sanitized = sanitized
        .split(secret)
        .join("[redacted: configured credential]");
  }
  return scrubSecretShapedContent(sanitized);
}

export function sanitizeDiagnosticValue(
  value: unknown,
  configuredSecrets: readonly (string | undefined)[],
): unknown {
  if (typeof value === "string")
    return sanitizeDiagnosticText(value, configuredSecrets);
  if (Array.isArray(value))
    return value.map((item) =>
      sanitizeDiagnosticValue(item, configuredSecrets),
    );
  if (value !== null && typeof value === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value))
      sanitized[key] = sanitizeDiagnosticValue(child, configuredSecrets);
    return sanitized;
  }
  return value;
}
