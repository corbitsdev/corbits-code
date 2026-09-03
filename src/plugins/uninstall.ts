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

function absPath(p: string, cwd?: string): string {
  return isAbsolute(p) ? resolve(p) : resolve(cwd ?? process.cwd(), p);
}

async function realOrLexical(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return resolve(p);
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
}

export type DeleteOwnedPluginDirResult = { ok: true } | { ok: false; message: string };

/**
 * Delete a discovered plugin directory after realpath + containment under the
 * origin plugins root. Refuses the root itself and anything under ~/.claude.
 * Missing paths are already gone from disk and succeed. No settings I/O.
 */
export async function deleteOwnedPluginDir(
  args: DeleteOwnedPluginDirArgs,
): Promise<DeleteOwnedPluginDirResult> {
  const claude = await realOrLexical(args.claudeRoot);
  let realPlugin: string;
  try {
    realPlugin = await realpath(args.pluginPath);
  } catch {
    const lexical = resolve(args.pluginPath);
    if (pathIsInsideOrEqual(lexical, claude)) {
      return { ok: false, message: "Refusing to delete a path under ~/.claude" };
    }
    // Already absent — caller still writes enabled:false / session state.
    return { ok: true };
  }
  if (pathIsInsideOrEqual(realPlugin, claude)) {
    return { ok: false, message: "Refusing to delete a path under ~/.claude" };
  }
  let realRoot: string;
  try {
    realRoot = await realpath(args.originRoot);
  } catch {
    return { ok: false, message: "Plugin path is outside the origin plugins root" };
  }
  if (realPlugin === realRoot) {
    return { ok: false, message: "Refusing to delete the plugins root" };
  }
  if (!pathIsInsideOrEqual(realPlugin, realRoot)) {
    return { ok: false, message: "Plugin path is outside the origin plugins root" };
  }
  await rm(realPlugin, { recursive: true, force: true });
  return { ok: true };
}

export function disableBundledPluginSettings(
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
