import { execFile } from "node:child_process";

export type DiffLineKind = "added" | "removed" | "context" | "hunk" | "meta";

export type DiffLine = { kind: DiffLineKind; text: string };

export type FileDiff = { path: string; lines: DiffLine[] };

export type DiffResult =
  | { available: true; files: FileDiff[] }
  | { available: false };

// The well-known empty-tree object. Diffing against it yields "everything is
// new", which is the correct baseline for a repository that has no commits yet
// (no HEAD to diff against).
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

function classifyLine(line: string, inHunk: boolean): DiffLineKind {
  if (line.startsWith("@@")) return "hunk";
  // Inside a hunk body, +/- always mean added/removed content — even when the
  // content itself begins with "+++"/"---" (e.g. deleting a "----" rule). The
  // file-header markers (+++/---, diff, index, ...) only appear before the
  // first hunk, so the meta checks are gated on being outside a hunk.
  if (inHunk) {
    if (line.startsWith("+")) return "added";
    if (line.startsWith("-")) return "removed";
    return "context";
  }
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("diff ") || line.startsWith("index ")) return "meta";
  if (line.startsWith("new file") || line.startsWith("deleted file")) return "meta";
  if (line.startsWith("similarity ") || line.startsWith("rename ")) return "meta";
  return "context";
}

function pathFromHeader(line: string): string | null {
  const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
  if (match === null) return null;
  return match[2] ?? match[1] ?? null;
}

export function parseDiff(raw: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  let inHunk = false;

  for (const line of raw.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const path = pathFromHeader(line);
      current = { path: path ?? "(unknown)", lines: [] };
      files.push(current);
      current.lines.push({ kind: "meta", text: line });
      inHunk = false;
      continue;
    }
    if (current === null) continue;
    if (line.startsWith("@@")) inHunk = true;
    current.lines.push({ kind: classifyLine(line, inHunk), text: line });
  }

  return files;
}

type GitResult = { code: number; stdout: string };

function runGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      // git diff exits non-zero when there are differences (e.g. --no-index);
      // stdout still holds the diff, so we resolve with both and let callers
      // decide. A spawn failure (git missing) surfaces as code 1 with no stdout.
      const code = error && typeof (error as { code?: unknown }).code === "number"
        ? (error as { code: number }).code
        : error
          ? 1
          : 0;
      resolve({ code, stdout: stdout ?? "" });
    });
  });
}

async function isRepository(cwd: string): Promise<boolean> {
  const result = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return result.code === 0 && result.stdout.trim() === "true";
}

async function hasHead(cwd: string): Promise<boolean> {
  const result = await runGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  return result.code === 0 && result.stdout.trim().length > 0;
}

// Untracked files never appear in `git diff`. Render each as a new-file diff via
// --no-index against /dev/null, which does not touch the index or working tree.
async function untrackedDiff(cwd: string): Promise<string> {
  const listed = await runGit(cwd, ["ls-files", "--others", "--exclude-standard"]);
  const paths = listed.stdout.split("\n").map((p) => p.trim()).filter((p) => p.length > 0);
  const parts: string[] = [];
  for (const path of paths) {
    const result = await runGit(cwd, ["diff", "--no-index", "--no-color", "--", "/dev/null", path]);
    if (result.stdout.length > 0) parts.push(result.stdout);
  }
  return parts.join("\n");
}

export async function getWorkingTreeDiff(cwd: string): Promise<DiffResult> {
  if (!(await isRepository(cwd))) return { available: false };

  const base = (await hasHead(cwd)) ? "HEAD" : EMPTY_TREE;
  const tracked = await runGit(cwd, ["diff", "--no-color", base]);
  const untracked = await untrackedDiff(cwd);

  const combined = [tracked.stdout, untracked].filter((s) => s.length > 0).join("\n");
  return { available: true, files: parseDiff(combined) };
}
