import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { MCPServerConfig } from "../config/settings.js";

/** Where a plugin was discovered from. */
export type PluginOrigin = "repo" | "user" | "project" | "path";

/** Origins that may execute code without a project trust entry. */
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

// SECURITY: trust records must NOT live inside the repo they authorize — a
// hostile repo could otherwise ship its own `.intercode/trust.json` and
// pre-grant consent to its plugins and MCP servers. We store them under the
// user's home, in a file keyed by the resolved repo path, so only prior
// interactive consent on THIS machine can populate them.
export function projectTrustPath(cwd: string, home: string = homedir()): string {
  const repo = resolve(cwd);
  const key = createHash("sha256").update(repo).digest("hex").slice(0, 32);
  return join(home, ".intercode", "trust", `${key}.json`);
}

export async function loadProjectTrust(cwd: string, home: string = homedir()): Promise<ProjectTrustStore> {
  try {
    const raw = await readFile(projectTrustPath(cwd, home), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object") return emptyStore();
    const o = parsed as Record<string, unknown>;
    // Guard against a stale/copied record keyed to a different repo path: the
    // file records the repo it was written for and must match this cwd.
    if (typeof o.repo === "string" && resolve(o.repo) !== resolve(cwd)) return emptyStore();
    const paths = Array.isArray(o.trustedPluginPaths)
      ? o.trustedPluginPaths.filter((p): p is string => typeof p === "string").map((p) => resolve(p))
      : [];
    const fps = Array.isArray(o.trustedMcpFingerprints)
      ? o.trustedMcpFingerprints.filter((f): f is string => typeof f === "string")
      : [];
    return { trustedPluginPaths: paths, trustedMcpFingerprints: fps };
  } catch {
    return emptyStore();
  }
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
