import { rm, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { SETTINGS_DIR_NAME } from "../branding.js";
import type { PluginConfig } from "../config/settings.js";
import type { PluginOrigin } from "../trust/project-trust.js";
import { pathIsInsideOrEqual } from "../util/path-contain.js";

export function userPluginsRoot(home: string = homedir()): string {
  return join(home, SETTINGS_DIR_NAME, "plugins");
}

export function projectPluginsRoot(cwd: string): string {
  return join(cwd, SETTINGS_DIR_NAME, "plugins");
}

export function claudeHomeRoot(home: string = homedir()): string {
  return join(home, ".claude");
}

function absPath(p: string, cwd: string): string {
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

async function realOrLexical(p: string, cwd: string): Promise<string> {
  const abs = absPath(p, cwd);
  try {
    return await realpath(abs);
  } catch {
    return abs;
  }
}

export function ownedDiskOriginRoot(args: {
  readonly pluginPath: string;
  readonly home: string;
  readonly cwd: string;
}): string | undefined {
  const abs = absPath(args.pluginPath, args.cwd);
  if (pathIsInsideOrEqual(abs, claudeHomeRoot(args.home))) return undefined;
  const userRoot = resolve(userPluginsRoot(args.home));
  const projectRoot = resolve(projectPluginsRoot(args.cwd));
  if (abs !== userRoot && pathIsInsideOrEqual(abs, userRoot)) return userRoot;
  if (abs !== projectRoot && pathIsInsideOrEqual(abs, projectRoot)) return projectRoot;
  return undefined;
}

export function isOwnedDiskInstall(args: {
  readonly origin: PluginOrigin;
  readonly pluginPath?: string;
  readonly home: string;
  readonly cwd: string;
}): boolean {
  // Ownership is path containment under the user or project plugins root,
  // never ~/.claude — origin is ignored so a path-origin plugin sitting in
  // those trees is treated as a disk install (and gone after restart).
  if (args.pluginPath === undefined) return false;
  return (
    ownedDiskOriginRoot({
      pluginPath: args.pluginPath,
      home: args.home,
      cwd: args.cwd,
    }) !== undefined
  );
}

export type PluginRemoveAction =
  "disable-bundled" | "disable-unowned-user" | "delete-owned" | "remove-path" | "cannot";

/** Shared TUI/runner policy for Alt+X / pluginsAdmin.remove. */
export function classifyPluginRemove(args: {
  readonly origin: PluginOrigin;
  readonly owned: boolean;
}): PluginRemoveAction {
  if (args.origin === "repo") return "disable-bundled";
  if (args.owned) return "delete-owned";
  if (args.origin === "user") return "disable-unowned-user";
  if (args.origin === "path") return "remove-path";
  return "cannot";
}

export interface DeleteOwnedPluginDirArgs {
  readonly pluginPath: string;
  readonly originRoot: string;
  readonly claudeRoot: string;
  /** Session cwd — relative paths resolve here, never `process.cwd()`. */
  readonly cwd: string;
}

export type DeleteOwnedPluginDirResult = { ok: true } | { ok: false; message: string };

/**
 * Delete a discovered plugin directory after realpath + containment under the
 * origin plugins root. Refuses the root itself and anything under ~/.claude.
 * A missing path or dangling symlink inside the origin root succeeds; a
 * missing path outside it is refused. No settings I/O.
 */
export async function deleteOwnedPluginDir(
  args: DeleteOwnedPluginDirArgs,
): Promise<DeleteOwnedPluginDirResult> {
  const claude = await realOrLexical(args.claudeRoot, args.cwd);
  const pluginAbs = absPath(args.pluginPath, args.cwd);
  let realPlugin: string;
  try {
    realPlugin = await realpath(pluginAbs);
  } catch {
    const lexical = pluginAbs;
    const lexicalClaude = absPath(args.claudeRoot, args.cwd);
    if (pathIsInsideOrEqual(lexical, lexicalClaude)) {
      return { ok: false, message: "Refusing to delete a path under ~/.claude" };
    }
    const lexicalRoot = absPath(args.originRoot, args.cwd);
    if (pathIsInsideOrEqual(lexical, lexicalRoot) && lexical !== resolve(lexicalRoot)) {
      // Missing, or a dangling symlink inside the origin root — `force` removes
      // the symlink without following it; a truly absent path is a no-op.
      await rm(lexical, { recursive: true, force: true });
      return { ok: true };
    }
    return { ok: false, message: "Plugin path is outside the origin plugins root" };
  }
  if (pathIsInsideOrEqual(realPlugin, claude)) {
    return { ok: false, message: "Refusing to delete a path under ~/.claude" };
  }
  const realRoot = await realOrLexical(args.originRoot, args.cwd);
  if (realPlugin === realRoot) {
    return { ok: false, message: "Refusing to delete the plugins root" };
  }
  if (!pathIsInsideOrEqual(realPlugin, realRoot)) {
    return { ok: false, message: "Plugin path is outside the origin plugins root" };
  }
  await rm(realPlugin, { recursive: true, force: true });
  return { ok: true };
}

export function disablePluginSettings(
  plugins: Record<string, PluginConfig>,
  id: string,
): Record<string, PluginConfig> {
  return { ...plugins, [id]: { ...(plugins[id] ?? {}), enabled: false } };
}

export async function nextPluginPathsAfterRemove(args: {
  readonly pluginPaths: readonly string[];
  readonly pluginPath: string;
  readonly cwd: string;
  readonly otherLivePluginPaths: readonly string[];
  readonly expandMembers: (abs: string) => Promise<readonly string[]>;
}): Promise<{ pluginPaths: string[]; keptSharedRoot: boolean }> {
  const target = absPath(args.pluginPath, args.cwd);
  const others = args.otherLivePluginPaths.map((p) => absPath(p, args.cwd));
  const next: string[] = [];
  let keptSharedRoot = false;
  for (const raw of args.pluginPaths) {
    const entry = absPath(raw, args.cwd);
    const members = (await args.expandMembers(entry)).map((m) => absPath(m, args.cwd));
    const identifies =
      entry === target || members.includes(target) || pathIsInsideOrEqual(target, entry);
    if (!identifies) {
      next.push(raw);
      continue;
    }
    const shared = others.some(
      (o) => o === entry || members.includes(o) || pathIsInsideOrEqual(o, entry),
    );
    if (shared) {
      next.push(raw);
      keptSharedRoot = true;
    }
  }
  return { pluginPaths: next, keptSharedRoot };
}

export interface PluginRemoveArgs {
  readonly id: string;
  readonly name: string;
  readonly origin: PluginOrigin;
  readonly pluginPath?: string;
  readonly hadTools: boolean;
  readonly home: string;
  readonly cwd: string;
  readonly plugins: Record<string, PluginConfig>;
  readonly pluginPaths: readonly string[];
  readonly webOverride?: string;
  readonly otherLivePluginPaths: readonly string[];
  readonly expandMembers: (abs: string) => Promise<readonly string[]>;
  readonly revokePathPlugin?: (path: string) => Promise<void>;
}

export type PluginRemoveResult =
  | {
      ok: true;
      message: string;
      plugins: Record<string, PluginConfig>;
      pluginPaths: string[];
      webOverride: string | undefined;
      spliceLive: boolean;
    }
  | { ok: false; message: string };

function withToolsNote(hadTools: boolean, message: string): string {
  return hadTools ? `${message} Tools from this plugin stay until you restart.` : message;
}

/**
 * Shared Alt+X / pluginsAdmin.remove policy: classify, optional disk delete,
 * path-drop, and `enabled: false`. Session lists and settings persist stay
 * with the caller.
 */
export async function executePluginRemove(args: PluginRemoveArgs): Promise<PluginRemoveResult> {
  const owned = isOwnedDiskInstall({
    origin: args.origin,
    ...(args.pluginPath !== undefined ? { pluginPath: args.pluginPath } : {}),
    home: args.home,
    cwd: args.cwd,
  });
  const action = classifyPluginRemove({ origin: args.origin, owned });
  const nextPlugins = disablePluginSettings(args.plugins, args.id);
  const nextWeb = args.webOverride === args.id ? undefined : args.webOverride;

  const disabled = (message: string): PluginRemoveResult => ({
    ok: true,
    message: withToolsNote(args.hadTools, message),
    plugins: nextPlugins,
    pluginPaths: [...args.pluginPaths],
    webOverride: nextWeb,
    spliceLive: false,
  });

  if (action === "disable-bundled") {
    return disabled(`${args.name} is bundled and cannot be uninstalled — disabled instead.`);
  }
  if (action === "disable-unowned-user") {
    return disabled(`Disabled ${args.name}. Claude marketplace files were not removed.`);
  }

  const dropPath = async (path: string): Promise<{ extra: string; pluginPaths: string[] }> => {
    if (args.revokePathPlugin !== undefined) await args.revokePathPlugin(path);
    const planned = await nextPluginPathsAfterRemove({
      pluginPaths: args.pluginPaths,
      pluginPath: path,
      cwd: args.cwd,
      otherLivePluginPaths: args.otherLivePluginPaths,
      expandMembers: args.expandMembers,
    });
    return {
      extra: planned.keptSharedRoot
        ? " Other plugins remain at that marketplace path; this one may return untrusted on restart."
        : "",
      pluginPaths: planned.pluginPaths,
    };
  };

  if (action === "delete-owned") {
    if (args.pluginPath === undefined) {
      return { ok: false, message: "Plugin has no path to remove" };
    }
    const originRoot = ownedDiskOriginRoot({
      pluginPath: args.pluginPath,
      home: args.home,
      cwd: args.cwd,
    });
    if (originRoot === undefined) {
      return { ok: false, message: "Plugin has no path to remove" };
    }
    const disk = await deleteOwnedPluginDir({
      pluginPath: args.pluginPath,
      originRoot,
      claudeRoot: claudeHomeRoot(args.home),
      cwd: args.cwd,
    });
    if (!disk.ok) return disk;
    let extra = "";
    let pluginPaths = [...args.pluginPaths];
    if (args.origin === "path") {
      const dropped = await dropPath(args.pluginPath);
      extra = dropped.extra;
      pluginPaths = dropped.pluginPaths;
    }
    return {
      ok: true,
      message: withToolsNote(args.hadTools, `Removed ${args.name}.${extra}`),
      plugins: nextPlugins,
      pluginPaths,
      webOverride: nextWeb,
      spliceLive: true,
    };
  }

  if (action === "remove-path") {
    let extra = "";
    let pluginPaths = [...args.pluginPaths];
    if (args.pluginPath !== undefined) {
      const dropped = await dropPath(args.pluginPath);
      extra = dropped.extra;
      pluginPaths = dropped.pluginPaths;
    }
    return {
      ok: true,
      message: withToolsNote(args.hadTools, `Removed ${args.name}.${extra}`),
      plugins: nextPlugins,
      pluginPaths,
      webOverride: nextWeb,
      spliceLive: true,
    };
  }

  return { ok: false, message: `Cannot remove ${args.name}` };
}
