import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { type } from "arktype";
import { getLogger } from "@intx/log";
import type { MCPServerConfig } from "../config/settings.js";
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

export type ProjectTrustStore = {
  /** Absolute plugin directory paths the user has trusted for this project. */
  trustedPluginPaths: string[];
  /** MCP fingerprints (see mcpServerFingerprint) trusted for this project. */
  trustedMcpFingerprints: string[];
};

const emptyStore = (): ProjectTrustStore => ({
  trustedPluginPaths: [],
  trustedMcpFingerprints: [],
});

/**
 * Extract a trust-store array field already confirmed to be an array (or
 * absent) by ProjectTrustRecordSchema: missing → [], mixed types keep only
 * strings. Hand-edited partial files must not wipe consent.
 */
function extractStringArrayField(value: unknown[] | undefined, field: string, path: string): string[] {
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

// SECURITY: project trust records must NOT live inside the repo they authorize —
// a hostile repo could otherwise ship its own `.corbits/trust.json` and
// pre-grant consent to its plugins and MCP servers. We store them under the
// user's home, in a file keyed by the resolved repo path, so only prior
// interactive consent on THIS machine can populate them. Path-origin plugins
// use a separate global store (`path-trust.ts`); do not OR the two lists.
export function projectTrustPath(cwd: string, home: string = homedir()): string {
  const repo = resolve(cwd);
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
  // file records the repo it was written for and must match this cwd.
  if (validated.repo !== undefined && resolve(validated.repo) !== resolve(cwd)) {
    logger.warn`project trust store repo mismatch at ${path}: recorded ${validated.repo}, expected ${resolve(cwd)}`;
    return { state: "invalid", store: emptyStore() };
  }
  return {
    state: "valid",
    store: {
      trustedPluginPaths: trustedPluginPaths.map((p) => resolve(p)),
      trustedMcpFingerprints: [...trustedMcpFingerprints],
    },
  };
}

export async function loadProjectTrust(cwd: string, home: string = homedir()): Promise<ProjectTrustStore> {
  return (await readProjectTrustStore(cwd, home)).store;
}

async function saveProjectTrust(cwd: string, store: ProjectTrustStore, home: string = homedir()): Promise<void> {
  const path = projectTrustPath(cwd, home);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const record = { repo: resolve(cwd), ...store };
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

export function isPluginTrusted(store: ProjectTrustStore, pluginPath: string): boolean {
  const abs = resolve(pluginPath);
  return store.trustedPluginPaths.includes(abs);
}

export async function trustPlugin(
  cwd: string,
  pluginPath: string,
  home: string = homedir(),
): Promise<ProjectTrustStore> {
  const store = await loadProjectTrust(cwd, home);
  const abs = resolve(pluginPath);
  if (!store.trustedPluginPaths.includes(abs)) {
    store.trustedPluginPaths = [...store.trustedPluginPaths, abs];
    await saveProjectTrust(cwd, store, home);
  }
  return store;
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
  const store = await loadProjectTrust(cwd, home);
  const fp = mcpServerFingerprint(server);
  if (!store.trustedMcpFingerprints.includes(fp)) {
    store.trustedMcpFingerprints = [...store.trustedMcpFingerprints, fp];
    await saveProjectTrust(cwd, store, home);
  }
  return store;
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
