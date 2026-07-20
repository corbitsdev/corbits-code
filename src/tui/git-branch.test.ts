import { test, expect } from "bun:test";
import { fetchGitBranch, parseGitBranchOutput } from "./git-branch.js";

test("parseGitBranchOutput returns the trimmed branch name on success", () => {
  expect(parseGitBranchOutput({ exitCode: 0, stdout: "main\n" })).toBe("main");
});

test("parseGitBranchOutput returns null on a non-zero exit code", () => {
  expect(parseGitBranchOutput({ exitCode: 128, stdout: "" })).toBe(null);
});

test("parseGitBranchOutput returns null for detached HEAD", () => {
  expect(parseGitBranchOutput({ exitCode: 0, stdout: "HEAD\n" })).toBe(null);
});

test("parseGitBranchOutput returns null for empty output", () => {
  expect(parseGitBranchOutput({ exitCode: 0, stdout: "   \n" })).toBe(null);
});

test("fetchGitBranch resolves the branch name via the injected git runner", async () => {
  const branch = await fetchGitBranch("/repo", async (cwd) => {
    expect(cwd).toBe("/repo");
    return { exitCode: 0, stdout: "feature/cl-3118\n" };
  });
  expect(branch).toBe("feature/cl-3118");
});

test("fetchGitBranch returns null when the git runner throws (not a repo, git missing, etc.)", async () => {
  const branch = await fetchGitBranch("/not-a-repo", async () => {
    throw new Error("spawn git ENOENT");
  });
  expect(branch).toBe(null);
});
