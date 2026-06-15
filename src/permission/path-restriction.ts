import { execFileSync } from "node:child_process";
import { resolve, sep } from "node:path";

// Paths the agent should not read without explicit operator approval, even
// though the read tools are otherwise allow-tier:
//
//   - anything under .agent-state (the agent's own run state) — off-limits
//     unless the operator asks it to self-reflect, trace, or investigate a run.
//   - anything git ignores — gitignored files are noise or secrets-adjacent and
//     should be surfaced only when genuinely required.
//
// Git owns gitignore semantics, so we ask `git check-ignore` rather than
// re-implementing ignore-file parsing. Results are cached per resolved path
// because the gate consults this on every read-tool call.

export type PathRestriction = {
  isRestricted: (path: string) => boolean;
};

const STATE_DIR = ".agent-state";

export function createPathRestriction(cwd: string): PathRestriction {
  const stateDir = resolve(cwd, STATE_DIR);
  const cache = new Map<string, boolean>();

  const underStateDir = (abs: string): boolean => abs === stateDir || abs.startsWith(stateDir + sep);

  const gitIgnores = (abs: string): boolean => {
    try {
      // Exit 0 means the path is ignored. A non-zero exit (not ignored, or not a
      // git repo) throws, which we read as "not restricted".
      execFileSync("git", ["check-ignore", "-q", "--", abs], { cwd, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };

  return {
    isRestricted: (path: string): boolean => {
      const abs = resolve(cwd, path);
      const cached = cache.get(abs);
      if (cached !== undefined) return cached;
      const restricted = underStateDir(abs) || gitIgnores(abs);
      cache.set(abs, restricted);
      return restricted;
    },
  };
}
