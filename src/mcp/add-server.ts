import { homedir } from "node:os";

import {
  isExaMCPPreset,
  loadGlobalSettingsWriteBase,
  loadLocalSettingsWriteBase,
  saveGlobalSettings,
  saveLocalSettings,
  type LocalSettings,
  type MCPServerConfig,
  type MCPServerSettingsEntry,
  type Settings,
} from "../config/settings.js";
import { deleteAuthState } from "./auth-store.js";
import { EXA_MCP_SERVER_NAME } from "./exa.js";

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

export interface LocalSettingsWriter {
  readonly enqueue: <T>(job: () => Promise<T>) => Promise<T>;
  readonly update: (
    apply: (base: LocalSettings) => LocalSettings | null,
  ) => Promise<LocalSettings | null>;
  readonly updateAt: (
    path: string,
    apply: (base: LocalSettings) => LocalSettings | null,
  ) => Promise<LocalSettings | null>;
  readonly mutate: (
    apply: (base: LocalSettings) => LocalSettings | null,
  ) => Promise<"ok" | "skipped">;
  readonly mutateAt: (
    path: string,
    apply: (base: LocalSettings) => LocalSettings | null,
  ) => Promise<"ok" | "skipped">;
}

interface LocalSettingsWriterDeps {
  readonly load: (path: string) => Promise<LocalSettings | null>;
  readonly save: (path: string, settings: LocalSettings) => Promise<void>;
}

const defaultLocalWriterDeps: LocalSettingsWriterDeps = {
  load: loadLocalSettingsWriteBase,
  save: saveLocalSettings,
};

export function createLocalSettingsWriter(
  path: string,
  deps: Partial<LocalSettingsWriterDeps> = {},
): LocalSettingsWriter {
  const writerDeps: LocalSettingsWriterDeps = { ...defaultLocalWriterDeps, ...deps };
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
    apply: (base: LocalSettings) => LocalSettings | null,
  ): Promise<LocalSettings | null> =>
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
    apply: (base: LocalSettings) => LocalSettings | null,
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

export type PersistMCPServerListResult =
  | {
      readonly ok: true;
      readonly entries: MCPServerSettingsEntry[];
      readonly omitted: boolean;
      readonly removed?: MCPServerSettingsEntry;
      readonly settings?: Settings;
      readonly local?: LocalSettings;
    }
  | {
      readonly ok: false;
      readonly reason: "not-found" | "builtin-exa" | "skipped";
    };

const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

export function validateMCPServerName(value: string): string | null {
  if (value.length === 0) return "Enter a server name first.";
  if (!MCP_SERVER_NAME_PATTERN.test(value) || value.includes("__")) {
    return 'Use letters, numbers, single underscores, or hyphens; "__" is reserved.';
  }
  return null;
}

export function parseAbsoluteHTTPURL(value: string): URL | null {
  const trimmed = value.trim();
  const scheme = trimmed.match(/^(https?):\/\//i);
  if (scheme === null) return null;
  const afterScheme = trimmed.slice(scheme[0].length);
  if (afterScheme.startsWith("/")) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username !== "" || url.password !== "") return null;
    if (url.hostname.length === 0 || url.hostname === "." || url.hostname.startsWith(".")) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

export function isAbsoluteHTTPURL(value: string): boolean {
  return parseAbsoluteHTTPURL(value) !== null;
}

export async function persistGlobalHTTPMCPServer(
  writer: GlobalSettingsWriter,
  rawName: string,
  rawURL: string,
  source: "local" | "global" | "none" = "global",
  isNameActive: (name: string) => boolean = () => false,
): Promise<PersistMCPServerResult> {
  const name = rawName.trim();
  const parsedURL = parseAbsoluteHTTPURL(rawURL);
  if (validateMCPServerName(name) !== null) return { ok: false, reason: "invalid-name" };
  if (parsedURL === null) return { ok: false, reason: "invalid-url" };
  if (source === "local") return { ok: false, reason: "local-shadow" };

  const server: MCPServerConfig = { name, type: "http", url: parsedURL.href };
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

function withoutEnabled(row: MCPServerSettingsEntry): MCPServerSettingsEntry {
  const { enabled: _enabled, ...rest } = row;
  return rest;
}

function omitMcpServers<T extends { mcpServers?: MCPServerSettingsEntry[] }>(base: T): T {
  const next = { ...base };
  delete next.mcpServers;
  return next;
}

export function setMCPServerEntryEnabled(
  entries: MCPServerSettingsEntry[],
  name: string,
  enabled: boolean,
): MCPServerSettingsEntry[] | null {
  const index = entries.findIndex((entry) => entry.name === name);
  if (index === -1) {
    if (name !== EXA_MCP_SERVER_NAME) return null;
    return [...entries, { name: EXA_MCP_SERVER_NAME, enabled }];
  }
  const row = entries[index];
  if (row === undefined) return null;
  const nextRow: MCPServerSettingsEntry = isExaMCPPreset(row)
    ? { name: EXA_MCP_SERVER_NAME, enabled }
    : enabled
      ? withoutEnabled(row)
      : { ...row, enabled: false };
  return entries.map((entry, i) => (i === index ? nextRow : entry));
}

export function removeMCPServerEntry(
  entries: MCPServerSettingsEntry[],
  name: string,
): { entries: MCPServerSettingsEntry[]; removed: MCPServerSettingsEntry } | null {
  const index = entries.findIndex((entry) => entry.name === name);
  if (index === -1) return null;
  const removed = entries[index];
  if (removed === undefined) return null;
  if (isExaMCPPreset(removed)) return null;
  return {
    entries: entries.filter((_, i) => i !== index),
    removed,
  };
}

function refuseRemovedEntry(
  entries: MCPServerSettingsEntry[],
  name: string,
): "not-found" | "builtin-exa" {
  const row = entries.find((entry) => entry.name === name);
  return row !== undefined && isExaMCPPreset(row) ? "builtin-exa" : "not-found";
}

async function deleteRemovedAuth(
  name: string,
  removed: MCPServerSettingsEntry | undefined,
  home: string,
): Promise<void> {
  if (removed === undefined || !("url" in removed) || removed.url === undefined) return;
  await deleteAuthState({ serverName: name, serverURL: removed.url }, home);
}

export async function persistMCPServerEnabled(
  writer: GlobalSettingsWriter,
  name: string,
  enabled: boolean,
): Promise<PersistMCPServerListResult> {
  let refuse: "not-found" | undefined;
  let entries: MCPServerSettingsEntry[] = [];
  const settings = await writer.update((base) => {
    const next = setMCPServerEntryEnabled(base.mcpServers ?? [], name, enabled);
    if (next === null) {
      refuse = "not-found";
      return null;
    }
    entries = next;
    return { ...base, mcpServers: next };
  });
  if (settings === null) return { ok: false, reason: "skipped" };
  if (refuse !== undefined) return { ok: false, reason: refuse };
  return { ok: true, entries, omitted: false, settings };
}

export async function persistMCPServerRemoved(
  writer: GlobalSettingsWriter,
  name: string,
  home: string = homedir(),
): Promise<PersistMCPServerListResult> {
  let refuse: "not-found" | "builtin-exa" | undefined;
  let entries: MCPServerSettingsEntry[] = [];
  let omitted = false;
  let removed: MCPServerSettingsEntry | undefined;
  const settings = await writer.update((base) => {
    const list = base.mcpServers ?? [];
    const result = removeMCPServerEntry(list, name);
    if (result === null) {
      refuse = refuseRemovedEntry(list, name);
      return null;
    }
    entries = result.entries;
    removed = result.removed;
    omitted = result.entries.length === 0;
    if (omitted) return omitMcpServers(base);
    return { ...base, mcpServers: result.entries };
  });
  if (settings === null) return { ok: false, reason: "skipped" };
  if (refuse !== undefined) return { ok: false, reason: refuse };
  if (removed === undefined) return { ok: false, reason: "not-found" };
  await deleteRemovedAuth(name, removed, home);
  return { ok: true, entries, omitted, removed, settings };
}

export async function persistLocalMCPServerEnabled(
  writer: LocalSettingsWriter,
  name: string,
  enabled: boolean,
): Promise<PersistMCPServerListResult> {
  let refuse: "not-found" | undefined;
  let entries: MCPServerSettingsEntry[] = [];
  const local = await writer.update((base) => {
    const next = setMCPServerEntryEnabled(base.mcpServers ?? [], name, enabled);
    if (next === null) {
      refuse = "not-found";
      return null;
    }
    entries = next;
    return { ...base, mcpServers: next };
  });
  if (local === null) return { ok: false, reason: "skipped" };
  if (refuse !== undefined) return { ok: false, reason: refuse };
  return { ok: true, entries, omitted: false, local };
}

export async function persistLocalMCPServerRemoved(
  writer: LocalSettingsWriter,
  name: string,
  home: string = homedir(),
): Promise<PersistMCPServerListResult> {
  let refuse: "not-found" | "builtin-exa" | undefined;
  let entries: MCPServerSettingsEntry[] = [];
  let omitted = false;
  let removed: MCPServerSettingsEntry | undefined;
  const local = await writer.update((base) => {
    const list = base.mcpServers ?? [];
    const result = removeMCPServerEntry(list, name);
    if (result === null) {
      refuse = refuseRemovedEntry(list, name);
      return null;
    }
    entries = result.entries;
    removed = result.removed;
    omitted = result.entries.length === 0;
    if (omitted) return omitMcpServers(base);
    return { ...base, mcpServers: result.entries };
  });
  if (local === null) return { ok: false, reason: "skipped" };
  if (refuse !== undefined) return { ok: false, reason: refuse };
  if (removed === undefined) return { ok: false, reason: "not-found" };
  await deleteRemovedAuth(name, removed, home);
  return { ok: true, entries, omitted, removed, local };
}
