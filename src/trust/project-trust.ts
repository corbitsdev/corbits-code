import { realpathSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { type } from "arktype";
import { getLogger } from "@intx/log";
import type { MCPServerConfig } from "../config/settings.js";
import { isBuiltinExaMCPServer } from "../mcp/exa.js";
import { isHttpServer } from "../mcp/is-http-server.js";
import { LOG_NAMESPACE_ROOT, SETTINGS_DIR_NAME } from "../branding.js";

const logger = getLogger([LOG_NAMESPACE_ROOT, "trust"]);

// Array fields are "unknown[]" so a mixed-type array keeps its string entries
// (filtered after validation) instead of failing the whole record like
// path-trust.ts's strict schema.
const ProjectTrustRecordSchema = type({
  "trustedPluginPaths?": "unknown[]",
  "trustedMcpFingerprints?": "unknown[]",
  "trustedGrantFingerprints?": "unknown[]",
  "repo?": "string",
});

/** Where a plugin was discovered from. */
export type PluginOrigin = "repo" | "user" | "project" | "path";

/** Origins that must not execute code until a trust gate passes
 * (project or path store). */
export function originRequiresTrust(origin: PluginOrigin): boolean {
  return origin === "project" || origin === "path";
}

export interface ProjectTrustStore {
  /** Absolute plugin directory paths the user has trusted for this project. */
  trustedPluginPaths: string[];
  /** MCP fingerprints (see mcpServerFingerprint) trusted for this project. */
  trustedMcpFingerprints: string[];
  /**
   * Grant fingerprints (see projectGrantFingerprint) confirmed for this
   * project's approvals file. Trusting the project never implies trusting its
   * grants: each entry requires its own operator confirmation.
   */
  trustedGrantFingerprints: string[];
}

const emptyStore = (): ProjectTrustStore => ({
  trustedPluginPaths: [],
  trustedMcpFingerprints: [],
  trustedGrantFingerprints: [],
});

/**
 * Extract a schema-confirmed array field: missing → [], non-strings dropped.
 * Hand-edited partial files must not wipe consent.
 */
function extractStringArrayField(
  value: unknown[] | undefined,
  field: string,
  path: string,
): string[] {
  if (value === undefined) {
    logger.warn`project trust store missing ${field} at ${path}; defaulting to []`;
    return [];
  }
  const strings: string[] = [];
  let dropped = 0;
  for (const entry of value) {
    if (typeof entry === "string") {
      strings.push(entry);
    } else {
      dropped += 1;
    }
  }
  if (dropped > 0) {
    logger.warn`project trust store dropping ${dropped} non-string entr${dropped === 1 ? "y" : "ies"} from ${field} at ${path}`;
  }
  return strings;
}

// Symlink twins of one repo (macOS /tmp vs /private/tmp) must key and compare
// as the same project, or grants written via one spelling vanish via the
// other. realpath collapses twins; a missing/unreadable path falls back to
// lexical resolve so this step never errors.
function canonicalizeCwd(cwd: string): string {
  const resolved = resolve(cwd);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

// SECURITY: trust records must not live inside the repo they authorize — a
// hostile repo could ship its own `.corbits/trust.json` and pre-grant consent.
// Store them under the user's home keyed by resolved repo path, so only prior
// interactive consent populates them. Path-origin plugins use a separate
// global store (path-trust.ts); do not OR the two lists.
export function projectTrustPath(
  cwd: string,
  home: string = homedir(),
): string {
  const repo = canonicalizeCwd(cwd);
  const key = createHash("sha256").update(repo).digest("hex").slice(0, 32);
  return join(home, SETTINGS_DIR_NAME, "trust", `${key}.json`);
}

/**
 * Read the store and report why it is empty: a missing file is normal, but an
 * unreadable, malformed, wrong-shape, or repo-mismatched file must be logged
 * invalid — mistaking it for "no grants" would silently reset consent.
 */
export async function readProjectTrustStore(
  cwd: string,
  home: string = homedir(),
): Promise<{
  state: "missing" | "invalid" | "valid";
  store: ProjectTrustStore;
}> {
  const path = projectTrustPath(cwd, home);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "missing", store: emptyStore() };
    }
    logger.warn`project trust store unreadable at ${path}: ${String(err)}`;
    return { state: "invalid", store: emptyStore() };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn`project trust store is not valid JSON at ${path}: ${String(err)}`;
    return { state: "invalid", store: emptyStore() };
  }
  // arktype's object schema accepts arrays, so reject a top-level array before
  // validation — otherwise it becomes an empty-but-"valid" store.
  if (Array.isArray(parsed)) {
    logger.warn`project trust store has an invalid shape at ${path}: expected object, got array`;
    return { state: "invalid", store: emptyStore() };
  }
  const validated = ProjectTrustRecordSchema(parsed);
  if (validated instanceof type.errors) {
    logger.warn`project trust store has an invalid shape at ${path}: ${validated.summary}`;
    return { state: "invalid", store: emptyStore() };
  }
  const trustedPluginPaths = extractStringArrayField(
    validated.trustedPluginPaths,
    "trustedPluginPaths",
    path,
  );
  const trustedMcpFingerprints = extractStringArrayField(
    validated.trustedMcpFingerprints,
    "trustedMcpFingerprints",
    path,
  );
  const trustedGrantFingerprints = extractStringArrayField(
    validated.trustedGrantFingerprints,
    "trustedGrantFingerprints",
    path,
  );
  // Reject a record keyed to another repo: the file stores its repo and it
  // must match this cwd. A missing or non-string `repo` is invalid too, or a
  // stripped store would apply its grants to whatever cwd hashes to this
  // filename.
  if (typeof validated.repo !== "string") {
    logger.warn`project trust store missing repo field at ${path}`;
    return { state: "invalid", store: emptyStore() };
  }
  if (canonicalizeCwd(validated.repo) !== canonicalizeCwd(cwd)) {
    logger.warn`project trust store repo mismatch at ${path}: recorded ${validated.repo}, expected ${canonicalizeCwd(cwd)}`;
    return { state: "invalid", store: emptyStore() };
  }
  // Grants are recorded absolute (see resolveAgainstProjectCwd); a relative
  // entry would bind to process.cwd() — the confused-cwd bug path-trust.ts
  // guards against. Drop it.
  const absolutePluginPaths: string[] = [];
  for (const p of trustedPluginPaths) {
    if (!isAbsolute(p)) {
      logger.warn`project trust store dropping non-absolute trustedPluginPaths entry at ${path}: ${p}`;
      continue;
    }
    absolutePluginPaths.push(resolve(p));
  }
  return {
    state: "valid",
    store: {
      trustedPluginPaths: absolutePluginPaths,
      trustedMcpFingerprints: [...trustedMcpFingerprints],
      trustedGrantFingerprints: [...trustedGrantFingerprints],
    },
  };
}

export async function loadProjectTrust(
  cwd: string,
  home: string = homedir(),
): Promise<ProjectTrustStore> {
  return (await readProjectTrustStore(cwd, home)).store;
}

// Temp-file + rename (as path-trust.ts) so a reader never sees a torn store,
// which would read as corrupt and wipe consent.
async function saveProjectTrust(
  cwd: string,
  store: ProjectTrustStore,
  home: string = homedir(),
): Promise<void> {
  const path = projectTrustPath(cwd, home);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const record = { repo: canonicalizeCwd(cwd), ...store };
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

// Grant helpers re-read the store right before writing, so interleaved
// in-process mutations would drop grants. Chain per store path so each
// mutation sees the previous one's result; cross-process writers stay
// last-writer-wins of a complete file, same as path-trust.ts.
const mutationQueues = new Map<string, Promise<unknown>>();

function enqueueMutation<T>(key: string, run: () => Promise<T>): Promise<T> {
  const prior = mutationQueues.get(key) ?? Promise.resolve();
  const next = prior.then(run, run);
  mutationQueues.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

// A relative pluginPath has no meaning until resolved against a cwd; resolving
// against process.cwd() (path.resolve's default) would trust a different
// directory than the caller's project. Callers pass relative paths, so
// resolve against the project cwd — path.resolve(cwd, pluginPath) leaves
// absolute paths untouched.
function resolveAgainstProjectCwd(cwd: string, pluginPath: string): string {
  return resolve(canonicalizeCwd(cwd), pluginPath);
}

export function isPluginTrusted(
  store: ProjectTrustStore,
  pluginPath: string,
  cwd: string = process.cwd(),
): boolean {
  const abs = resolveAgainstProjectCwd(cwd, pluginPath);
  return store.trustedPluginPaths.includes(abs);
}

export async function trustPlugin(
  cwd: string,
  pluginPath: string,
  home: string = homedir(),
): Promise<ProjectTrustStore> {
  const abs = resolveAgainstProjectCwd(cwd, pluginPath);
  return enqueueMutation(projectTrustPath(cwd, home), async () => {
    const store = await loadProjectTrust(cwd, home);
    if (!store.trustedPluginPaths.includes(abs)) {
      store.trustedPluginPaths = [...store.trustedPluginPaths, abs];
      await saveProjectTrust(cwd, store, home);
    }
    return store;
  });
}

/**
 * Stable fingerprint for an MCP server's spawn identity. Env key names, not
 * values, are folded in so a new injected variable invalidates a prior grant.
 */
export function mcpServerFingerprint(server: MCPServerConfig): string {
  const payload = JSON.stringify({
    name: server.name,
    type: server.type ?? (server.url !== undefined ? "http" : "stdio"),
    command: server.command ?? "",
    args: server.args ?? [],
    url: server.url ?? "",
    env: server.env !== undefined ? Object.keys(server.env).sort() : [],
  });
  return createHash("sha256").update(payload).digest("hex");
}

// Display-only quoting for the MCP trust prompt: one escape for argv, name,
// and url so newlines, quotes, and Unicode/C1 breaks cannot spoof extra
// prompt lines. Whitespace/quote/empty args render double-quoted so ["a b"]
// and ["a", "b"] never look alike. Approval identity comes from
// mcpServerFingerprint, never this rendering.
function isTrustPromptControlChar(code: number): boolean {
  return (
    code <= 0x1f ||
    code === 0x7f ||
    (code >= 0x80 && code <= 0x9f) ||
    code === 0x2028 ||
    code === 0x2029
  );
}

function escapeMcpTrustText(value: string): string {
  const named = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  let escaped = "";
  for (const ch of named) {
    const code = ch.charCodeAt(0);
    if (!isTrustPromptControlChar(code)) {
      escaped += ch;
      continue;
    }
    escaped +=
      code <= 0xff
        ? `\\x${code.toString(16).toUpperCase().padStart(2, "0")}`
        : `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return escaped;
}

function quoteMcpTrustArg(arg: string): string {
  const needsQuotes =
    arg === "" ||
    /[\s"]/.test(arg) ||
    [...arg].some((ch) => isTrustPromptControlChar(ch.charCodeAt(0)));
  if (!needsQuotes) return arg;
  return `"${escapeMcpTrustText(arg)}"`;
}

function formatMcpSpawnCommand(command: string, args: string[]): string {
  const head = quoteMcpTrustArg(command);
  return args.length === 0
    ? head
    : `${head} ${args.map(quoteMcpTrustArg).join(" ")}`;
}

export function formatMcpTrustQuestion(server: MCPServerConfig): string {
  const header = `Trust local MCP server "${escapeMcpTrustText(server.name)}" for this project?`;
  if (isHttpServer(server)) {
    return server.url !== undefined
      ? `${header}\nURL: ${quoteMcpTrustArg(server.url)}`
      : header;
  }
  if (server.command !== undefined) {
    return `${header}\nCommand: ${formatMcpSpawnCommand(server.command, server.args ?? [])}`;
  }
  return header;
}

export function isMcpServerTrusted(
  store: ProjectTrustStore,
  server: MCPServerConfig,
): boolean {
  return store.trustedMcpFingerprints.includes(mcpServerFingerprint(server));
}

export async function trustMcpServer(
  cwd: string,
  server: MCPServerConfig,
  home: string = homedir(),
): Promise<ProjectTrustStore> {
  const fp = mcpServerFingerprint(server);
  return enqueueMutation(projectTrustPath(cwd, home), async () => {
    const store = await loadProjectTrust(cwd, home);
    if (!store.trustedMcpFingerprints.includes(fp)) {
      store.trustedMcpFingerprints = [...store.trustedMcpFingerprints, fp];
      await saveProjectTrust(cwd, store, home);
    }
    return store;
  });
}

/**
 * Stable fingerprint for one project-approval entry: tool + pattern, plus the
 * provider-model binding when set, so switching models invalidates a prior
 * confirmation like the gate's providerModel check. Cwd is folded in too
 * (absent → ""): a cwd-less grant matches any request cwd (cwdMatchesGrant),
 * so ignoring cwd would let a hand-edit that drops `cwd` keep its
 * confirmation and silently widen a repo-confined grant to cross-repo.
 */
export function projectGrantFingerprint(approval: {
  tool: string;
  pattern: string;
  providerModel?: string;
  cwd?: string;
}): string {
  const payload = JSON.stringify({
    tool: approval.tool,
    pattern: approval.pattern,
    providerModel: approval.providerModel ?? "",
    cwd: approval.cwd ?? "",
  });
  return createHash("sha256").update(payload).digest("hex");
}

export function isProjectGrantTrusted(
  store: ProjectTrustStore,
  approval: {
    tool: string;
    pattern: string;
    providerModel?: string;
    cwd?: string;
  },
): boolean {
  return store.trustedGrantFingerprints.includes(
    projectGrantFingerprint(approval),
  );
}

/**
 * Record the operator's confirmation of project-approval entries. Fingerprints
 * are written only when the operator persists a grant to project scope (the
 * saveProjectApproval write is the confirmation), never by the file's mere
 * existence.
 */
export async function trustProjectGrants(
  cwd: string,
  approvals: {
    tool: string;
    pattern: string;
    providerModel?: string;
    cwd?: string;
  }[],
  home: string = homedir(),
): Promise<ProjectTrustStore> {
  const fps = approvals.map(projectGrantFingerprint);
  return enqueueMutation(projectTrustPath(cwd, home), async () => {
    const store = await loadProjectTrust(cwd, home);
    const missing = fps.filter(
      (fp) => !store.trustedGrantFingerprints.includes(fp),
    );
    if (missing.length > 0) {
      store.trustedGrantFingerprints = [
        ...store.trustedGrantFingerprints,
        ...missing,
      ];
      await saveProjectTrust(cwd, store, home);
    }
    return store;
  });
}

/** Drop confirmations for removed entries so a replanted file re-surfaces. */
export async function untrustProjectGrants(
  cwd: string,
  approvals: {
    tool: string;
    pattern: string;
    providerModel?: string;
    cwd?: string;
  }[],
  home: string = homedir(),
): Promise<ProjectTrustStore> {
  const fps = new Set(approvals.map(projectGrantFingerprint));
  return enqueueMutation(projectTrustPath(cwd, home), async () => {
    const store = await loadProjectTrust(cwd, home);
    const kept = store.trustedGrantFingerprints.filter((fp) => !fps.has(fp));
    if (kept.length !== store.trustedGrantFingerprints.length) {
      store.trustedGrantFingerprints = kept;
      await saveProjectTrust(cwd, store, home);
    }
    return store;
  });
}

/**
 * Revocation by absence: drop trusted fingerprints with no on-disk entry.
 * untrustProjectGrants only runs on the removeProjectApproval path, so a
 * hand-edit that deletes an entry would leave its fingerprint trusted and a
 * byte-identical replant would apply silently. Trust follows the file: removal
 * revokes confirmation; replanting re-surfaces as pending.
 */
export async function reconcileProjectGrants(
  cwd: string,
  onDisk: {
    tool: string;
    pattern: string;
    providerModel?: string;
    cwd?: string;
  }[],
  home: string = homedir(),
): Promise<ProjectTrustStore> {
  const live = new Set(onDisk.map(projectGrantFingerprint));
  return enqueueMutation(projectTrustPath(cwd, home), async () => {
    const store = await loadProjectTrust(cwd, home);
    const kept = store.trustedGrantFingerprints.filter((fp) => live.has(fp));
    if (kept.length !== store.trustedGrantFingerprints.length) {
      store.trustedGrantFingerprints = kept;
      await saveProjectTrust(cwd, store, home);
    }
    return store;
  });
}

/**
 * Filter MCP servers that may connect. Global-source servers are always
 * allowed; local-source servers require a trust fingerprint (or an
 * interactive grant callback).
 */
export async function filterMcpServersForConnect(
  servers: MCPServerConfig[],
  opts: {
    source: "local" | "global" | "none";
    store: ProjectTrustStore;
    cwd: string;
    /** Home dir for the trust store; defaults to the real home in production. */
    home?: string;
    /** Interactive TOFU: return true to trust+connect. Headless should omit
     * (fail closed). */
    requestTrust?: (server: MCPServerConfig) => Promise<boolean>;
  },
): Promise<MCPServerConfig[]> {
  if (opts.source !== "local") return servers;
  const allowed: MCPServerConfig[] = [];
  let store = opts.store;
  for (const server of servers) {
    if (isBuiltinExaMCPServer(server)) {
      allowed.push(server);
      continue;
    }
    if (isMcpServerTrusted(store, server)) {
      allowed.push(server);
      continue;
    }
    if (opts.requestTrust !== undefined && (await opts.requestTrust(server))) {
      store = await trustMcpServer(opts.cwd, server, opts.home);
      allowed.push(server);
    }
    // else: fail closed — do not connect
  }
  return allowed;
}
