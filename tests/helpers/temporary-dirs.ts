import { mkdtempSync, rmSync } from "node:fs";
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
