import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { release, type as osType } from "node:os";
import { promisify } from "node:util";

const run = promisify(execFile);

export type EnvironmentInfo = {
  cwd: string;
  platform: string;
  date: Date;
  isGitRepo: boolean;
  gitBranch?: string;
  gitDirtyCount?: number;
  gitStatusSummary?: string;
  topLevel?: string;
};

const GIT_STATUS_LINES = 12;
const TOP_LEVEL_ENTRIES = 40;

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run("git", args, { cwd, timeout: 3000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function gatherGit(cwd: string): Promise<Partial<EnvironmentInfo>> {
  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside !== "true") return { isGitRepo: false };

  const branch = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const status = await git(cwd, ["status", "--porcelain"]);
  const lines = status ? status.split("\n").filter((l) => l.length > 0) : [];
  const summary = lines.slice(0, GIT_STATUS_LINES).join("\n");
  const extra = lines.length - GIT_STATUS_LINES;

  return {
    isGitRepo: true,
    ...(branch ? { gitBranch: branch } : {}),
    gitDirtyCount: lines.length,
    gitStatusSummary: extra > 0 ? `${summary}\n... and ${extra} more` : summary,
  };
}

async function gatherTopLevel(cwd: string): Promise<string | undefined> {
  try {
    const entries = await readdir(cwd, { withFileTypes: true });
    const names = entries
      .filter((e) => !e.name.startsWith("."))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
    const shown = names.slice(0, TOP_LEVEL_ENTRIES).join("  ");
    return names.length > TOP_LEVEL_ENTRIES ? `${shown}  …` : shown;
  } catch {
    return undefined;
  }
}

export async function gatherEnvironment(cwd: string, date = new Date()): Promise<EnvironmentInfo> {
  const [gitInfo, topLevel] = await Promise.all([gatherGit(cwd), gatherTopLevel(cwd)]);
  return {
    cwd,
    platform: `${osType()} ${release()}`,
    date,
    isGitRepo: false,
    ...gitInfo,
    ...(topLevel ? { topLevel } : {}),
  };
}
