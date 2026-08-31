import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { arch, release, type as osType } from "node:os";

export interface EnvironmentInfo {
  cwd: string;
  platform: string;
  /** CPU architecture (e.g. arm64, x64). */
  arch: string;
  /** Runtime label (e.g. Bun 1.2.x or Node 22.x). */
  runtime: string;
  date: Date;
  isGitRepo: boolean;
  gitBranch?: string;
  gitDirtyCount?: number;
  gitStatusSummary?: string;
  topLevel?: string;
}

const GIT_STATUS_LINES = 12;
const TOP_LEVEL_ENTRIES = 40;

const GIT_TIMEOUT_MS = 3000;

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
      if (child.stdout === null) {
        reject(new Error("git stdout is not available"));
        return;
      }
      let out = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        out += chunk;
      });
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("git timed out"));
      }, GIT_TIMEOUT_MS);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else reject(new Error("git failed"));
      });
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

export type GitRunner = (cwd: string, args: string[]) => Promise<string | null>;

// Detached HEAD (or a repo with zero commits) makes rev-parse print "HEAD"
// itself rather than a branch name; treat that as "no branch".
export async function getGitBranch(cwd: string, runGit: GitRunner = git): Promise<string | null> {
  const branch = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === null || branch.length === 0 || branch === "HEAD") return null;
  return branch;
}

async function gatherGit(cwd: string): Promise<Partial<EnvironmentInfo>> {
  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside !== "true") return { isGitRepo: false };

  // Branch and status both depend only on being inside a work tree, so run
  // their subprocesses concurrently rather than paying each 3s timeout in turn.
  const [branch, status] = await Promise.all([
    getGitBranch(cwd),
    git(cwd, ["status", "--porcelain"]),
  ]);
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
  const runtime =
    typeof Bun !== "undefined" ? `Bun ${Bun.version}` : `Node ${process.versions.node}`;
  return {
    cwd,
    platform: `${osType()} ${release()}`,
    arch: arch(),
    runtime,
    date,
    isGitRepo: false,
    ...gitInfo,
    ...(topLevel ? { topLevel } : {}),
  };
}
