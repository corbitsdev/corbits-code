import type { MCPServerConfig, Settings } from "../config/settings.js";
import { loadGlobalSettingsWriteBase, saveGlobalSettings } from "../config/settings.js";

export interface GlobalSettingsWriter {
  readonly enqueue: <T>(job: () => Promise<T>) => Promise<T>;
  readonly update: (apply: (base: Settings) => Settings | null) => Promise<Settings | null>;
  readonly updateAt: (
    path: string,
    apply: (base: Settings) => Settings | null,
  ) => Promise<Settings | null>;
  readonly mutate: (apply: (base: Settings) => Settings | null) => Promise<"ok" | "skipped">;
  readonly mutateAt: (
    path: string,
    apply: (base: Settings) => Settings | null,
  ) => Promise<"ok" | "skipped">;
}

interface GlobalSettingsWriterDeps {
  readonly load: (path: string) => Promise<Settings | null>;
  readonly save: (path: string, settings: Settings) => Promise<void>;
}

const defaultWriterDeps: GlobalSettingsWriterDeps = {
  load: loadGlobalSettingsWriteBase,
  save: saveGlobalSettings,
};

export function createGlobalSettingsWriter(
  path: string,
  deps: Partial<GlobalSettingsWriterDeps> = {},
): GlobalSettingsWriter {
  const writerDeps: GlobalSettingsWriterDeps = { ...defaultWriterDeps, ...deps };
  let tail = Promise.resolve();
  const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
    const run = tail.then(job);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const updateAt = (
    settingsPath: string,
    apply: (base: Settings) => Settings | null,
  ): Promise<Settings | null> =>
    enqueue(async () => {
      const base = await writerDeps.load(settingsPath);
      if (base === null) return null;
      const next = apply(base);
      if (next === null) return base;
      await writerDeps.save(settingsPath, next);
      return next;
    });

  const mutateAt = async (
    settingsPath: string,
    apply: (base: Settings) => Settings | null,
  ): Promise<"ok" | "skipped"> =>
    (await updateAt(settingsPath, apply)) === null ? "skipped" : "ok";

  return {
    enqueue,
    update: (apply) => updateAt(path, apply),
    updateAt,
    mutate: (apply) => mutateAt(path, apply),
    mutateAt,
  };
}

export type PersistMCPServerResult =
  | { readonly ok: true; readonly server: MCPServerConfig; readonly settings: Settings }
  | {
      readonly ok: false;
      readonly reason:
        "invalid-name" | "invalid-url" | "duplicate" | "active" | "skipped" | "local-shadow";
    };

const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

export function validateMCPServerName(value: string): string | null {
  if (value.length === 0) return "Enter a server name first.";
  if (!MCP_SERVER_NAME_PATTERN.test(value) || value.includes("__")) {
    return 'Use letters, numbers, single underscores, or hyphens; "__" is reserved.';
  }
  return null;
}

export function isAbsoluteHTTPURL(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin !== "null";
  } catch {
    return false;
  }
}

export async function persistGlobalHTTPMCPServer(
  writer: GlobalSettingsWriter,
  rawName: string,
  rawURL: string,
  source: "local" | "global" | "none" = "global",
  isNameActive: (name: string) => boolean = () => false,
): Promise<PersistMCPServerResult> {
  const name = rawName.trim();
  const url = rawURL.trim();
  if (validateMCPServerName(name) !== null) return { ok: false, reason: "invalid-name" };
  if (!isAbsoluteHTTPURL(url)) return { ok: false, reason: "invalid-url" };
  if (source === "local") return { ok: false, reason: "local-shadow" };

  const server: MCPServerConfig = { name, type: "http", url };
  let active = false;
  let duplicate = false;
  const settings = await writer.update((base) => {
    if (isNameActive(name)) {
      active = true;
      return null;
    }
    const servers = base.mcpServers ?? [];
    if (servers.some((entry) => entry.name === name)) {
      duplicate = true;
      return null;
    }
    return { ...base, mcpServers: [...servers, server] };
  });
  if (settings === null) return { ok: false, reason: "skipped" };
  if (active) return { ok: false, reason: "active" };
  if (duplicate) return { ok: false, reason: "duplicate" };
  return { ok: true, server, settings };
}
