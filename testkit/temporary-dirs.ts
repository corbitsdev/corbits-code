import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempDirs {
  readonly cwd: string;
  readonly home: string;
  cleanup(): void;
}

/**
 * Creates a paired cwd/home temp dir set for tests that need an isolated
 * working directory plus an isolated `HOME`. `cleanup` removes both dirs --
 * call it from a `finally` block so the pair never leaks on failure.
 */
export function createTempDirs(
  cwdPrefix: string,
  homePrefix: string,
): TempDirs {
  const cwd = mkdtempSync(join(tmpdir(), cwdPrefix));
  const home = mkdtempSync(join(tmpdir(), homePrefix));
  return {
    cwd,
    home,
    cleanup(): void {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** Runs `body` inside a fresh temp dir, always removing it afterwards. */
export async function withTempDir(
  prefix: string,
  body: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
