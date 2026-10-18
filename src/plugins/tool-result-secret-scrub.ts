import { AsyncLocalStorage } from "node:async_hooks";

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

// A *_key name is a credential only when a secret marker is its own
// underscore-separated segment (api_key, MY_API_KEY, private_key, OPENAI_KEY).
// Storage roles such as partition_key, sort_key, primary_key, cache_key, and
// prompt_cache_key have no such segment, so they stay. Marker-free vendor keys
// are left alone on purpose: missing a rare key beats wiping database keys.
const CREDENTIAL_KEY_MARKER =
  "api|secret|private|access|auth|token|password|credential|openai";
const MARKER_KEY_SUFFIX = `(?:[a-z0-9]+_)*(?:${CREDENTIAL_KEY_MARKER})_key`;

const SECRET_QUERY_PARAMETER = new RegExp(
  `([?&](?:api[_-]?key|access[_-]?token|token|password|secret|credential|${MARKER_KEY_SUFFIX})=)(?!\\[redacted: looks like a credential\\])[^&#\\s]+`,
  "gi",
);

const JSON_CREDENTIAL_FIELD = new RegExp(
  `("(?:api[_-]?key|access[_-]?token|token|password|secret|credential|authorization|${MARKER_KEY_SUFFIX})"\\s*:\\s*")([^"\\r\\n]+)(")`,
  "gi",
);

// Grep/shell lines often look like path:line:KEY=value
const ENV_ASSIGNMENT = /(?:^|:)([A-Z][A-Z0-9_]+)=([^\n]+)/gm;

// Connection-string env names (DATABASE_URL and friends). Redaction additionally
// requires a credential-bearing value (see carriesConnectionCredentials), so
// benign sqlite paths and bare hostnames in tool output stay readable.
function isConnectionStringEnvKey(key: string): boolean {
  return (
    /(?:_|^)(?:URL|URI|DSN)$/.test(key) || key.includes("CONNECTION_STRING")
  );
}

// True when a connection-string value actually carries credentials: URI
// userinfo of the form scheme://user:pass@host (a colon in the authority
// before @, and before the next / or ?), or embedded password= material.
// ADO-style DSNs carry Password= without a scheme, so the password check
// does not require ://. An @ in the path or query (npm scopes, profile
// URLs, email query params) is not userinfo.
function carriesConnectionCredentials(value: string): boolean {
  return /password=/i.test(value) || hasCredentialUserinfo(value);
}

function hasCredentialUserinfo(value: string): boolean {
  const schemeSep = value.indexOf("://");
  if (schemeSep < 0) return false;
  const rest = value.slice(schemeSep + 3);
  const path = rest.indexOf("/");
  const query = rest.indexOf("?");
  let authorityEnd = rest.length;
  if (path >= 0) authorityEnd = Math.min(authorityEnd, path);
  if (query >= 0) authorityEnd = Math.min(authorityEnd, query);
  const authority = rest.slice(0, authorityEnd);
  const at = authority.indexOf("@");
  if (at < 0) return false;
  return authority.slice(0, at).includes(":");
}

function isSecretEnvKey(key: string, value: string): boolean {
  if (/(?:SECRET|TOKEN|PASSWORD|PRIVATE|CREDENTIAL|AUTH)/.test(key)) {
    return true;
  }
  // Bare-KEY class (OPENAI_KEY, STRIPE_KEY, API_KEY): ENV-assignment scope
  // only. The (^|_) boundary keeps plain words ending in KEY (MONKEY) out.
  if (/(?:^|_)KEY$/.test(key)) return true;
  if (isConnectionStringEnvKey(key)) return carriesConnectionCredentials(value);
  return false;
}

function replaceAll(
  text: string,
  pattern: RegExp,
  replacement: string,
): string {
  return text.replace(pattern, replacement);
}

// One scan before the full-text passes. Each alternative drops constraints
// from exactly one pattern above, so any match of those patterns is a match
// here. Extra matches are safe: they only pay for the passes. /i is required
// for query and JSON case-folding; it also over-matches the case-sensitive
// patterns. Not global — RegExp.test would otherwise keep lastIndex.
//
// PEM: every match contains "PRIVATE KEY-----".
// API keys: sk- / ghp_ / gho_ / xox[baprs]- / AKIA / Bearer\s / Basic\s
// (\b and minimum lengths are stricter than these literals).
// Query: the key is glued to "=". access[_-]?token always contains "token=".
// Marker prefixes sit in front of "{marker}_key=", so they cannot hide it.
// JSON: the same keys are glued to a closing quote, optional space, and ":".
// access[_-]?token therefore contains token"\s*:. authorization is JSON-only.
// Prefixed marker keys still contain {marker}_key"\s*:.
// ENV: every match contains (?:^|:)[A-Z][A-Z0-9_]+= with /m. The value length
// check is dropped. /i makes this alternative match lowercase too.
const SECRET_SHAPE_PREFILTER = new RegExp(
  [
    "PRIVATE KEY-----",
    "sk-",
    "ghp_",
    "gho_",
    String.raw`xox[baprs]-`,
    "AKIA",
    String.raw`Bearer\s`,
    String.raw`Basic\s`,
    "api[-_]?key=",
    "token=",
    "password=",
    "secret=",
    "credential=",
    "secret_key=",
    "private_key=",
    "access_key=",
    "auth_key=",
    "token_key=",
    "password_key=",
    "credential_key=",
    "openai_key=",
    String.raw`api[-_]?key"\s*:`,
    String.raw`token"\s*:`,
    String.raw`password"\s*:`,
    String.raw`secret"\s*:`,
    String.raw`credential"\s*:`,
    String.raw`authorization"\s*:`,
    String.raw`secret_key"\s*:`,
    String.raw`private_key"\s*:`,
    String.raw`access_key"\s*:`,
    String.raw`auth_key"\s*:`,
    String.raw`token_key"\s*:`,
    String.raw`password_key"\s*:`,
    String.raw`credential_key"\s*:`,
    String.raw`openai_key"\s*:`,
    String.raw`(?:^|:)[A-Z][A-Z0-9_]+=`,
  ].join("|"),
  "im",
);

const expensivePassCounter = new AsyncLocalStorage<{ count: number }>();

function noteExpensiveSecretScrubPass(): void {
  const counter = expensivePassCounter.getStore();
  if (counter !== undefined) counter.count += 1;
}

/** Runs `run` and reports entries into the full-text scrub passes. */
export function countExpensiveSecretScrubPasses(run: () => void): number {
  const counter = { count: 0 };
  expensivePassCounter.run(counter, run);
  return counter.count;
}

function patternHits(pattern: RegExp, text: string): boolean {
  pattern.lastIndex = 0;
  try {
    return pattern.test(text);
  } finally {
    pattern.lastIndex = 0;
  }
}

/** True when any scrub pattern matches. Test seam for the prefilter. */
export function secretScrubPatternHits(text: string): boolean {
  return (
    patternHits(PEM_BLOCK, text) ||
    API_KEY_PATTERNS.some((pattern) => patternHits(pattern, text)) ||
    patternHits(SECRET_QUERY_PARAMETER, text) ||
    patternHits(JSON_CREDENTIAL_FIELD, text) ||
    patternHits(ENV_ASSIGNMENT, text)
  );
}

export function scrubSecretShapedContent(text: string): string {
  if (!SECRET_SHAPE_PREFILTER.test(text)) return text;
  noteExpensiveSecretScrubPass();
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

  result = result.replace(
    ENV_ASSIGNMENT,
    (match, key: string, value: string) => {
      if (!isSecretEnvKey(key, value)) return match;
      const assignment = `${key}=${value}`;
      const prefix = match.slice(0, match.length - assignment.length);
      return `${prefix}${key}=${CREDENTIAL_REDACTION}`;
    },
  );

  return result;
}

const JSON_SAFE_ERROR = "Tool result is not JSON-safe";
// Bare-KEY class (OPENAI_KEY, MY_API_KEY). The marker segment keeps storage
// roles (partition_key, sort_key, cache_key) readable, and requiring _key
// keeps MONKEY and a field named exactly "key" readable.
const CREDENTIAL_FIELD = new RegExp(
  `^(?:api[_ -]?key|access[_ -]?token|token|password|secret|credential|authorization|auth|${MARKER_KEY_SUFFIX})$`,
  "i",
);

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
