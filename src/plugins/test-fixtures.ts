/**
 * Shared fixtures for plugin tests: a per-test scratch dir that materializes
 * plugin layouts and a stub CommandContext.
 */

import { afterEach, beforeEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandContext } from "../tui/commands/registry.js";

export interface PluginDir {
  /** Create a plugin dir under the per-test root from `relPath: content` entries (parent dirs created as needed). */
  makePlugin(layout: Record<string, string>): Promise<string>;
}

/** Per-test scratch root: created before each test, removed after. */
export function usePluginDir(): PluginDir {
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ic-test-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return {
    async makePlugin(layout) {
      const dir = join(root, `p-${Math.random().toString(36).slice(2)}`);
      for (const [relPath, content] of Object.entries(layout)) {
        const fullPath = join(dir, relPath);
        await mkdir(join(fullPath, ".."), { recursive: true });
        await writeFile(fullPath, content, "utf8");
      }
      return dir;
    },
  };
}

export const stubCommandContext: CommandContext = {
  signalClear: () => undefined,
};
