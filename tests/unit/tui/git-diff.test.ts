import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDiff, getWorkingTreeDiff } from "../../../src/tui/git-diff.js";

const SAMPLE = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 context line
-old line
+new line
diff --git a/src/b.ts b/src/b.ts
new file mode 100644
index 000..333
--- /dev/null
+++ b/src/b.ts
@@ -0,0 +1 @@
+brand new
`;

test("parseDiff splits into one FileDiff per file", () => {
  const files = parseDiff(SAMPLE);
  expect(files.length).toBe(2);
  expect(files[0]?.path).toBe("src/a.ts");
  expect(files[1]?.path).toBe("src/b.ts");
});

test("parseDiff classifies line kinds", () => {
  const files = parseDiff(SAMPLE);
  const kinds = files[0]?.lines.map((l) => l.kind) ?? [];
  expect(kinds).toContain("hunk");
  expect(kinds).toContain("added");
  expect(kinds).toContain("removed");
  expect(kinds).toContain("context");
  expect(kinds).toContain("meta");
});

test("parseDiff added and removed map to the right text", () => {
  const files = parseDiff(SAMPLE);
  const added = files[0]?.lines.find((l) => l.kind === "added");
  const removed = files[0]?.lines.find((l) => l.kind === "removed");
  expect(added?.text).toBe("+new line");
  expect(removed?.text).toBe("-old line");
});

test("parseDiff returns no files for empty input", () => {
  expect(parseDiff("")).toEqual([]);
});

test("hunk-body lines beginning with +++/--- classify as added/removed, not meta", () => {
  const raw = [
    "diff --git a/doc.md b/doc.md",
    "index 111..222 100644",
    "--- a/doc.md",
    "+++ b/doc.md",
    "@@ -1,2 +1,2 @@",
    "---- old underline",
    "++++ new banner",
    " context",
  ].join("\n");
  const lines = parseDiff(raw)[0]?.lines ?? [];
  const byText = (t: string) => lines.find((l) => l.text === t);
  // The real file headers before the hunk are still meta.
  expect(byText("--- a/doc.md")?.kind).toBe("meta");
  expect(byText("+++ b/doc.md")?.kind).toBe("meta");
  // Inside the hunk, content that happens to start with ---/+++ is real change.
  expect(byText("---- old underline")?.kind).toBe("removed");
  expect(byText("++++ new banner")?.kind).toBe("added");
});

test("getWorkingTreeDiff returns unavailable outside a repository", async () => {
  // Use a freshly-created temp dir that is guaranteed to not be inside any git
  // work tree — relying on "/" is fragile because the host machine may have a
  // git repo at its root (e.g. in CI or some macOS configurations).
  const nonRepo = await mkdtemp(join(tmpdir(), "diff-nonrepo-"));
  try {
    const result = await getWorkingTreeDiff(nonRepo);
    expect(result.available).toBe(false);
  } finally {
    await import("node:fs/promises").then((fs) => fs.rm(nonRepo, { recursive: true, force: true }));
  }
});

test("getWorkingTreeDiff returns a structured result inside a repository", async () => {
  const result = await getWorkingTreeDiff(process.cwd());
  expect(result.available).toBe(true);
  if (result.available) {
    expect(Array.isArray(result.files)).toBe(true);
  }
});

test("a fresh repo with no commits is available and shows untracked files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "diff-nohead-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    // Provide local git identity so git does not read global config under
    // parallel load, which can produce warnings that corrupt stdout captures.
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "new.ts"), "export const answer = 42;\n");

    const result = await getWorkingTreeDiff(dir);
    expect(result.available).toBe(true);
    if (result.available) {
      const text = result.files.flatMap((f) => f.lines).map((l) => l.text).join("\n");
      expect(text).toContain("answer = 42");
    }
  } finally {
    await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true }));
  }
});

test("many untracked files are capped instead of diffed exhaustively", async () => {
  const dir = await mkdtemp(join(tmpdir(), "diff-many-untracked-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
    await mkdir(join(dir, "generated"), { recursive: true });
    for (let i = 0; i < 25; i++) {
      await writeFile(join(dir, "generated", `file-${i}.txt`), `file ${i}\n`);
    }

    const result = await getWorkingTreeDiff(dir);
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.files.length).toBe(21);
      expect(result.files.at(-1)?.path).toBe("(5 more untracked files)");
    }
  } finally {
    await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true }));
  }
});
