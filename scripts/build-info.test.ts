import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { withTempDir } from "../testkit/temporary-dirs.js";
import {
  collectGitInfo,
  composeDisplayVersion,
  type GitInfo,
  type RunResult,
} from "./build-info.js";

const repoRoot = join(import.meta.dir, "..");
const scriptPath = join(repoRoot, "scripts", "build-info.ts");

const DISPLAY_VERSION_RE =
  /^v\d+\.\d+\.\d+(-\d+-g[0-9a-f]+)?(\+g[0-9a-f]+)?(-dirty)?$/;

describe("composeDisplayVersion", () => {
  test("on tag, clean tree -> plain version", () => {
    const info: GitInfo = {
      tag: "v0.3.36",
      count: 0,
      hash: "9af7e1e",
      dirty: false,
    };
    expect(composeDisplayVersion("0.3.36", info)).toBe("v0.3.36");
  });

  test("on tag, dirty tree -> -dirty suffix", () => {
    const info: GitInfo = {
      tag: "v0.3.36",
      count: 0,
      hash: "9af7e1e",
      dirty: true,
    };
    expect(composeDisplayVersion("0.3.36", info)).toBe("v0.3.36-dirty");
  });

  test("N commits past tag -> -N-g<hash>", () => {
    const info: GitInfo = {
      tag: "v0.3.36",
      count: 7,
      hash: "9af7e1e",
      dirty: false,
    };
    expect(composeDisplayVersion("0.3.36", info)).toBe("v0.3.36-7-g9af7e1e");
  });

  test("N commits past tag, dirty -> -N-g<hash>-dirty", () => {
    const info: GitInfo = {
      tag: "v0.3.36",
      count: 7,
      hash: "9af7e1e",
      dirty: true,
    };
    expect(composeDisplayVersion("0.3.36", info)).toBe(
      "v0.3.36-7-g9af7e1e-dirty",
    );
  });

  test("no tags -> +g<hash>", () => {
    const info: GitInfo = {
      tag: null,
      count: null,
      hash: "9af7e1e",
      dirty: false,
    };
    expect(composeDisplayVersion("0.3.36", info)).toBe("v0.3.36+g9af7e1e");
  });

  test("no tags, dirty -> +g<hash>-dirty", () => {
    const info: GitInfo = {
      tag: null,
      count: null,
      hash: "9af7e1e",
      dirty: true,
    };
    expect(composeDisplayVersion("0.3.36", info)).toBe(
      "v0.3.36+g9af7e1e-dirty",
    );
  });

  test("not a git repo / metadata unavailable -> plain version", () => {
    const info: GitInfo = {
      tag: null,
      count: null,
      hash: null,
      dirty: false,
    };
    expect(composeDisplayVersion("0.3.36", info)).toBe("v0.3.36");
  });
});

interface FakeSpec {
  stdout?: string;
  exitCode?: number;
  throws?: boolean;
}

function fakeRun(specs: Record<string, FakeSpec>) {
  return (args: string[]): RunResult => {
    const spec = specs[args.join(" ")] ?? {};
    if (spec.throws) throw new Error(`git ${args.join(" ")} exploded`);
    return { stdout: spec.stdout ?? "", exitCode: spec.exitCode ?? 0 };
  };
}

describe("collectGitInfo", () => {
  test("git repo, clean tree", () => {
    const run = fakeRun({
      "rev-parse --is-inside-work-tree": { stdout: "true" },
      "describe --tags --match v* --abbrev=0": { stdout: "v0.3.36" },
      "rev-list --count v0.3.36..HEAD": { stdout: "7" },
      "rev-parse --short=7 HEAD": { stdout: "9af7e1e" },
      "diff-index --quiet HEAD --": { exitCode: 0 },
    });
    expect(collectGitInfo("/repo", run)).toEqual({
      tag: "v0.3.36",
      count: 7,
      hash: "9af7e1e",
      dirty: false,
    });
  });

  test("git repo, dirty tree (diff-index exits 1)", () => {
    const run = fakeRun({
      "rev-parse --is-inside-work-tree": { stdout: "true" },
      "describe --tags --match v* --abbrev=0": { stdout: "v0.3.36" },
      "rev-list --count v0.3.36..HEAD": { stdout: "7" },
      "rev-parse --short=7 HEAD": { stdout: "9af7e1e" },
      "diff-index --quiet HEAD --": { exitCode: 1 },
    });
    expect(collectGitInfo("/repo", run)).toEqual({
      tag: "v0.3.36",
      count: 7,
      hash: "9af7e1e",
      dirty: true,
    });
  });

  test("git repo, exactly on tag", () => {
    const run = fakeRun({
      "rev-parse --is-inside-work-tree": { stdout: "true" },
      "describe --tags --match v* --abbrev=0": { stdout: "v0.3.36" },
      "rev-list --count v0.3.36..HEAD": { stdout: "0" },
      "rev-parse --short=7 HEAD": { stdout: "9af7e1e" },
      "diff-index --quiet HEAD --": { exitCode: 0 },
    });
    expect(collectGitInfo("/repo", run)).toEqual({
      tag: "v0.3.36",
      count: 0,
      hash: "9af7e1e",
      dirty: false,
    });
  });

  test("no tags (describe throws) degrades tag/count, keeps hash", () => {
    const run = fakeRun({
      "rev-parse --is-inside-work-tree": { stdout: "true" },
      "describe --tags --match v* --abbrev=0": { throws: true },
      "rev-parse --short=7 HEAD": { stdout: "9af7e1e" },
      "diff-index --quiet HEAD --": { exitCode: 0 },
    });
    expect(collectGitInfo("/repo", run)).toEqual({
      tag: null,
      count: null,
      hash: "9af7e1e",
      dirty: false,
    });
  });

  test("not a git repo (--is-inside-work-tree -> false)", () => {
    const run = fakeRun({
      "rev-parse --is-inside-work-tree": { stdout: "false" },
    });
    expect(collectGitInfo("/outside", run)).toEqual({
      tag: null,
      count: null,
      hash: null,
      dirty: false,
    });
  });

  test("git missing (rev-parse exits non-zero) -> all null", () => {
    const run = fakeRun({
      "rev-parse --is-inside-work-tree": { exitCode: 128 },
    });
    expect(collectGitInfo("/outside", run)).toEqual({
      tag: null,
      count: null,
      hash: null,
      dirty: false,
    });
  });
});

describe("build-info CLI", () => {
  test("outside a git repo prints a plain-version define", async () => {
    await withTempDir("build-info-not-git-", async (dir) => {
      const res = spawnSync(process.execPath, [scriptPath], {
        cwd: dir,
        encoding: "utf8",
      });
      expect(res.status).toBe(0);
      expect(res.stdout.trim()).toBe(
        'process.env.CORBITS_BUILD_INFO="v0.3.36"',
      );
    });
  });

  test("from the repo root prints a define matching the suffix regex", () => {
    const res = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(res.status).toBe(0);
    const line = res.stdout.trim();
    expect(line.startsWith("process.env.CORBITS_BUILD_INFO=")).toBe(true);
    const value: string = JSON.parse(
      line.slice("process.env.CORBITS_BUILD_INFO=".length),
    );
    expect(value).toMatch(DISPLAY_VERSION_RE);
  });
});
