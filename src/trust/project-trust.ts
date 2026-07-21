import { mkdir, readFile, writeFile } from "node:fs/promises";
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

export function projectTrustPath(cwd: string): string {
  return join(resolve(cwd), ".intercode", "trust.json");
}

export async function loadProjectTrust(cwd: string): Promise<ProjectTrustStore> {
  try {
    const raw = await readFile(projectTrustPath(cwd), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object") return emptyStore();
    const o = parsed as Record<string, unknown>;
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

async function saveProjectTrust(cwd: string, store: ProjectTrustStore): Promise<void> {
  const path = projectTrustPath(cwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

export function isPluginTrusted(store: ProjectTrustStore, pluginPath: string): boolean {
  const abs = resolve(pluginPath);
  return store.trustedPluginPaths.includes(abs);
}

export async function trustPlugin(cwd: string, pluginPath: string): Promise<ProjectTrustStore> {
  const store = await loadProjectTrust(cwd);
  const abs = resolve(pluginPath);
  if (!store.trustedPluginPaths.includes(abs)) {
    store.trustedPluginPaths = [...store.trustedPluginPaths, abs];
    await saveProjectTrust(cwd, store);
  }
  return store;
}

/** Stable fingerprint for an MCP server config (spawn identity, not secrets in env values alone). */
export function mcpServerFingerprint(server: MCPServerConfig): string {
  const payload = JSON.stringify({
    name: server.name,
    type: server.type ?? (server.url !== undefined ? "http" : "stdio"),
    command: server.command ?? "",
    args: server.args ?? [],
    url: server.url ?? "",
  });
  return createHash("sha256").update(payload).digest("hex");
}

export function isMcpServerTrusted(store: ProjectTrustStore, server: MCPServerConfig): boolean {
  return store.trustedMcpFingerprints.includes(mcpServerFingerprint(server));
}

export async function trustMcpServer(cwd: string, server: MCPServerConfig): Promise<ProjectTrustStore> {
  const store = await loadProjectTrust(cwd);
  const fp = mcpServerFingerprint(server);
  if (!store.trustedMcpFingerprints.includes(fp)) {
    store.trustedMcpFingerprints = [...store.trustedMcpFingerprints, fp];
    await saveProjectTrust(cwd, store);
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
      store = await trustMcpServer(opts.cwd, server);
      allowed.push(server);
    }
    // else: fail closed — do not connect
  }
  return allowed;
}
