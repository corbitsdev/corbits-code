// Scrub secret-shaped substrings from tool result text before it enters the
// transcript. Complements secret-guard (path denylist) for secrets that surface
// via directory-wide grep/shell output.

export const CREDENTIAL_REDACTION = "[redacted: looks like a credential]";

const PEM_BLOCK =
  /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g;

// High-confidence provider / platform token shapes.
const API_KEY_PATTERNS: RegExp[] = [
  /\bsk-[a-zA-Z0-9_-]{20,}\b/g,
  /\bghp_[a-zA-Z0-9]{36,}\b/g,
  /\bgho_[a-zA-Z0-9]{36,}\b/g,
  /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[a-zA-Z0-9_\-.]{20,}\b/g,
];

// Grep/shell lines often look like path:line:KEY=value
const ENV_ASSIGNMENT = /(?:^|:)([A-Z][A-Z0-9_]+)=([^\n]+)/gm;

function isSecretEnvKey(key: string): boolean {
  return (
    key === "API_KEY" ||
    /(?:SECRET|TOKEN|PASSWORD|PRIVATE|CREDENTIAL|AUTH)/.test(key)
  );
}

function replaceAll(text: string, pattern: RegExp, replacement: string): string {
  return text.replace(pattern, replacement);
}

export function scrubSecretShapedToolResultContent(text: string): string {
  let result = text;

  result = replaceAll(result, PEM_BLOCK, CREDENTIAL_REDACTION);

  for (const pattern of API_KEY_PATTERNS) {
    result = replaceAll(result, pattern, CREDENTIAL_REDACTION);
  }

  result = result.replace(ENV_ASSIGNMENT, (match, key: string) => {
    if (!isSecretEnvKey(key)) return match;
    const prefixEnd = match.lastIndexOf(key);
    const prefix = match.slice(0, prefixEnd);
    return `${prefix}${key}=${CREDENTIAL_REDACTION}`;
  });

  return result;
}