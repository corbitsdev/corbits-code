import { execFile } from "node:child_process";

export type DiffLineKind = "added" | "removed" | "context" | "hunk" | "meta";

export type DiffLine = { kind: DiffLineKind; text: string };

export type FileDiff = { path: string; lines: DiffLine[] };

export type DiffResult =
  | { available: true; files: FileDiff[] }
  | { available: false };

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

function runGitDiff(cwd: string): Promise<{ ok: true; raw: string } | { ok: false }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["diff", "HEAD"],
      { cwd, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error !== null) {
          resolve({ ok: false });
          return;
        }
        resolve({ ok: true, raw: stdout });
      },
    );
  });
}

export async function getWorkingTreeDiff(cwd: string): Promise<DiffResult> {
  const result = await runGitDiff(cwd);
  if (!result.ok) return { available: false };
  return { available: true, files: parseDiff(result.raw) };
}
