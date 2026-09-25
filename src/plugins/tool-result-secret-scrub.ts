// Scrub secret-shaped substrings before untrusted text reaches a transcript or
// terminal. Complements secret-guard (path denylist) for secrets that surface
// in tool output and upstream diagnostics.

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
  /\bBasic\s+[a-zA-Z0-9+/]{8,}={0,2}/g,
];

const SECRET_QUERY_PARAMETER =
  /([?&](?:api[_-]?key|access[_-]?token|token|password|secret|credential)=)(?!\[redacted: looks like a credential\])[^&#\s]+/gi;

const JSON_CREDENTIAL_FIELD =
  /("(?:api[_-]?key|access[_-]?token|token|password|secret|credential|authorization)"\s*:\s*")([^"\r\n]+)(")/gi;

// Grep/shell lines often look like path:line:KEY=value
const ENV_ASSIGNMENT = /(?:^|:)([A-Z][A-Z0-9_]+)=([^\n]+)/gm;

// CL-7790 decision: connection-string keys (DATABASE_URL and friends) are
// deliberately NOT matched here. Widening this shape-classifier would redact
// every benign connection string in tool output — a false-positive blast
// radius on a scrub path, not a prompt path. That needs its own measured
// ticket; the gap stays documented, not silently fixed.
function isSecretEnvKey(key: string): boolean {
  return (
    key === "API_KEY" ||
    /(?:SECRET|TOKEN|PASSWORD|PRIVATE|CREDENTIAL|AUTH)/.test(key)
  );
}

function replaceAll(
  text: string,
  pattern: RegExp,
  replacement: string,
): string {
  return text.replace(pattern, replacement);
}

export function scrubSecretShapedContent(text: string): string {
  let result = text;

  result = replaceAll(result, PEM_BLOCK, CREDENTIAL_REDACTION);

  for (const pattern of API_KEY_PATTERNS) {
    result = replaceAll(result, pattern, CREDENTIAL_REDACTION);
  }

  result = result.replace(
    SECRET_QUERY_PARAMETER,
    (_match, prefix: string) => `${prefix}${CREDENTIAL_REDACTION}`,
  );
  result = result.replace(
    JSON_CREDENTIAL_FIELD,
    (_match, prefix: string, _value: string, suffix: string) =>
      `${prefix}${CREDENTIAL_REDACTION}${suffix}`,
  );

  result = result.replace(ENV_ASSIGNMENT, (match, key: string) => {
    if (!isSecretEnvKey(key)) return match;
    const prefixEnd = match.lastIndexOf(key);
    const prefix = match.slice(0, prefixEnd);
    return `${prefix}${key}=${CREDENTIAL_REDACTION}`;
  });

  return result;
}

const JSON_SAFE_ERROR = "Tool result is not JSON-safe";
const CREDENTIAL_FIELD =
  /^(?:api[_ -]?key|access[_ -]?token|token|password|secret|credential|authorization|auth)$/i;

/**
 * Returns a detached JSON-safe value without invoking input accessors or custom
 * serialization. Records use a null prototype so every JSON key remains data.
 */
export function scrubSecretShapedValue(value: unknown): unknown {
  try {
    return normalizeJSONValue(value, new Set<object>());
  } catch {
    throw new TypeError(JSON_SAFE_ERROR);
  }
}

function normalizeJSONValue(value: unknown, ancestors: Set<object>): unknown {
  if (value === null) return null;
  if (typeof value === "string") return scrubSecretShapedContent(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(JSON_SAFE_ERROR);
    return value;
  }
  if (typeof value !== "object") throw new TypeError(JSON_SAFE_ERROR);
  if (ancestors.has(value)) throw new TypeError(JSON_SAFE_ERROR);

  ancestors.add(value);
  try {
    if (Array.isArray(value)) return normalizeJSONArray(value, ancestors);
    return normalizeJSONObject(value, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function normalizeJSONArray(
  value: unknown[],
  ancestors: Set<object>,
): unknown[] {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(JSON_SAFE_ERROR);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new TypeError(JSON_SAFE_ERROR);
    if (key === "length") continue;
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || String(index) !== key) {
      throw new TypeError(JSON_SAFE_ERROR);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(JSON_SAFE_ERROR);
    }
  }

  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined) return null;
    if (!("value" in descriptor)) throw new TypeError(JSON_SAFE_ERROR);
    return normalizeJSONValue(descriptor.value, ancestors);
  });
}

function normalizeJSONObject(
  value: object,
  ancestors: Set<object>,
): Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(JSON_SAFE_ERROR);
  }

  const out: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new TypeError(JSON_SAFE_ERROR);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      throw new TypeError(JSON_SAFE_ERROR);
    }
    const normalized = normalizeJSONValue(descriptor.value, ancestors);
    const scrubbedKey = uniqueScrubbedKey(out, scrubSecretShapedContent(key));
    Object.defineProperty(out, scrubbedKey, {
      value: CREDENTIAL_FIELD.test(key) ? CREDENTIAL_REDACTION : normalized,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return out;
}

function uniqueScrubbedKey(
  target: Record<string, unknown>,
  scrubbedKey: string,
): string {
  if (!Object.hasOwn(target, scrubbedKey)) return scrubbedKey;
  let collisionIndex = 2;
  while (Object.hasOwn(target, `${scrubbedKey} [${collisionIndex}]`)) {
    collisionIndex++;
  }
  return `${scrubbedKey} [${collisionIndex}]`;
}
