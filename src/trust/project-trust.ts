import { realpathSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { type } from "arktype";
import { getLogger } from "@intx/log";
import type { MCPServerConfig } from "../config/settings.js";
import { isBuiltinExaMCPServer } from "../mcp/exa.js";
import { LOG_NAMESPACE_ROOT, SETTINGS_DIR_NAME } from "../branding.js";

const logger = getLogger([LOG_NAMESPACE_ROOT, "trust"]);

// Array fields are typed "unknown[]" rather than "string[]" because, unlike
// path-trust.ts's strict schema, a mixed-type array here must keep its valid
// string entries instead of invalidating the whole record — filtering happens
// after arktype confirms the field is at least an array.
const ProjectTrustRecordSchema = type({
  "trustedPluginPaths?": "unknown[]",
  "trustedMcpFingerprints?": "unknown[]",
  "repo?": "string",
});

/** Where a plugin was discovered from. */
export type PluginOrigin = "repo" | "user" | "project" | "path";

/** Origins that must not execute code until a trust gate passes (project or path store). */
export function originRequiresTrust(origin: PluginOrigin): boolean {
  return origin === "project" || origin === "path";
}

export interface ProjectTrustStore {
  /** Absolute plugin directory paths the user has trusted for this project. */
  trustedPluginPaths: string[];
  /** MCP fingerprints (see mcpServerFingerprint) trusted for this project. */
  trustedMcpFingerprints: string[];
}

const emptyStore = (): ProjectTrustStore => ({
  trustedPluginPaths: [],
  trustedMcpFingerprints: [],
});

/**
 * Extract a trust-store array field already confirmed to be an array (or
 * absent) by ProjectTrustRecordSchema: missing → [], mixed types keep only
 * strings. Hand-edited partial files must not wipe consent.
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

// Symlink twins of the same repo (e.g. macOS's /tmp -> /private/tmp) must key
// and compare as the same project — otherwise grants written via one spelling
// are invisible via the other (fail-closed availability) and each spelling
// accumulates its own duplicate store. realpath collapses the twins; a path
// that doesn't exist yet (or isn't readable) falls back to the lexical
// resolve so callers never see an error from this normalization step alone.
function canonicalizeCwd(cwd: string): string {
  const resolved = resolve(cwd);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

// SECURITY: project trust records must NOT live inside the repo they authorize —
// a hostile repo could otherwise ship its own `.corbits/trust.json` and
// pre-grant consent to its plugins and MCP servers. We store them under the
// user's home, in a file keyed by the resolved repo path, so only prior
// interactive consent on THIS machine can populate them. Path-origin plugins
// use a separate global store (`path-trust.ts`); do not OR the two lists.
export function projectTrustPath(cwd: string, home: string = homedir()): string {
  const repo = canonicalizeCwd(cwd);
  const key = createHash("sha256").update(repo).digest("hex").slice(0, 32);
  return join(home, SETTINGS_DIR_NAME, "trust", `${key}.json`);
}

/**
 * Read the project trust store and report why it is empty when it is: a missing
 * file is normal (no grants yet), while an unreadable, malformed, wrong-shape,
 * or repo-mismatched file must not be mistaken for "no grants" without a log —
 * that would silently reset consent.
 */
export async function readProjectTrustStore(
  cwd: string,
  home: string = homedir(),
): Promise<{ state: "missing" | "invalid" | "valid"; store: ProjectTrustStore }> {
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
  // arktype's plain object schema accepts arrays (Array.isArray(x) && typeof x
  // === "object"), so a top-level JSON array must be rejected explicitly before
  // validation — otherwise it degrades to an empty-but-"valid" store instead of
  // being flagged corrupt.
  if (Array.isArray(parsed)) {
    logger.warn`project trust store has an invalid shape at ${path}: expected object, got array`;
    return { state: "invalid", store: emptyStore() };
  }
  const validated = ProjectTrustRecordSchema(parsed);
  if (validated instanceof type.errors) {
    logger.warn`project trust store has an invalid shape at ${path}: ${validated.summary}`;
    return { state: "invalid", store: emptyStore() };
  }
  // Coerce array fields instead of hard-rejecting: a hand-edited partial file
  // (only one list present) or a mixed-type array must keep valid string grants.
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
  // Guard against a stale/copied record keyed to a different repo path: the
  // file records the repo it was written for and must match this cwd. A
  // missing or non-string `repo` is invalid too — without it, a hand-edited
  // or stripped store would apply its grants to whatever cwd happens to hash
  // to this filename, defeating the mismatch guard entirely.
  if (typeof validated.repo !== "string") {
    logger.warn`project trust store missing repo field at ${path}`;
    return { state: "invalid", store: emptyStore() };
  }
  if (canonicalizeCwd(validated.repo) !== canonicalizeCwd(cwd)) {
    logger.warn`project trust store repo mismatch at ${path}: recorded ${validated.repo}, expected ${canonicalizeCwd(cwd)}`;
    return { state: "invalid", store: emptyStore() };
  }
  // Grants are recorded as absolute paths (see requireAbsolute below); a
  // relative entry has no fixed meaning on load — resolving it here would
  // bind to whatever process.cwd() happens to be, the same confused-cwd bug
  // path-trust.ts guards against on disk. Drop it instead of guessing.
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
    },
  };
}

export async function loadProjectTrust(
  cwd: string,
  home: string = homedir(),
): Promise<ProjectTrustStore> {
  return (await readProjectTrustStore(cwd, home)).store;
}

// Written via temp-file + rename (same pattern as path-trust.ts / saveGlobalSettings)
// so a concurrent reader never sees a truncated or half-written store — a torn
// read would be indistinguishable from a corrupt file and wipe consent.
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

// The grant helpers re-read the store immediately before writing, but two
// in-process mutations interleaving between that read and the write would
// still drop grants (e.g. a plugin-trust and an MCP-trust update landing at
// the same time). Chain them per trust-store path so each mutation sees the
// previous one's result. (Cross-process writers remain last-writer-wins of a
// complete file, same as path-trust.ts.)
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

// A relative pluginPath has no fixed meaning until resolved against some cwd;
// resolving it against process.cwd() (path.resolve's default) would trust a
// different directory than the caller's project, the confused-cwd bug
// path-trust.ts avoids by requiring absolute paths outright. Project trust
// callers pass relative paths in practice, so resolve against the given
// project cwd instead of rejecting — path.resolve(cwd, pluginPath) leaves an
// already-absolute pluginPath untouched.
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
 * Stable fingerprint for an MCP server config (spawn identity, not secrets in
 * env values alone). The env key names — not values — are folded in so adding
 * a new injected variable invalidates a prior grant.
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

export function isMcpServerTrusted(store: ProjectTrustStore, server: MCPServerConfig): boolean {
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
 * Filter MCP servers that may connect. Global-source servers are always allowed.
 * Local-source servers require a trust fingerprint (or an interactive grant callback).
 */
export async function filterMcpServersForConnect(
  servers: MCPServerConfig[],
  opts: {
    source: "local" | "global" | "none";
    store: ProjectTrustStore;
    cwd: string;
    /** Home dir for the trust store; defaults to the real home in production. */
    home?: string;
    /** Interactive TOFU. Return true to trust+connect. Headless should omit (fail closed). */
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
