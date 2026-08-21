import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { initEvalGitRepo, parseArgs } from "./eval-capability.ts";

const execFileAsync = promisify(execFile);

describe("parseArgs", () => {
  test("--help does not require provider or model", () => {
    const opts = parseArgs(["--help"]);
    expect(opts.help).toBe(true);
    expect(opts.provider).not.toBe("xai/thegreataxios");
    expect(opts.model).not.toBe("xai/thegreataxios");
  });

  test("no flags throws", () => {
    expect(() => parseArgs([])).toThrow(/--provider/);
    expect(() => parseArgs([])).toThrow(/--model/);
  });

  test("--provider without --model throws", () => {
    expect(() => parseArgs(["--provider", "foo"])).toThrow(/--model/);
  });

  test("--model without --provider throws", () => {
    expect(() => parseArgs(["--model", "bar"])).toThrow(/--provider/);
  });

  test("--provider foo --model bar parses those values", () => {
    const opts = parseArgs(["--provider", "foo", "--model", "bar"]);
    expect(opts.provider).toBe("foo");
    expect(opts.model).toBe("bar");
  });

  test("--dry-run without pair throws", () => {
    expect(() => parseArgs(["--dry-run"])).toThrow(/--provider/);
    expect(() => parseArgs(["--dry-run"])).toThrow(/--model/);
  });

  test("--matrix xai:grok-4.5 is enough without top-level flags", () => {
    const opts = parseArgs(["--matrix", "xai:grok-4.5"]);
    expect(opts.matrix).toBe("xai:grok-4.5");
  });

  test("incomplete matrix cell throws", () => {
    expect(() => parseArgs(["--matrix", "xai:"])).toThrow(/both provider and model/);
    expect(() => parseArgs(["--matrix", ":grok-4.5"])).toThrow(/both provider and model/);
  });

  test("parsed defaults never equal xai/thegreataxios", () => {
    const help = parseArgs(["--help"]);
    const pair = parseArgs(["--provider", "foo", "--model", "bar"]);
    expect(help.provider).not.toBe("xai/thegreataxios");
    expect(help.model).not.toBe("xai/thegreataxios");
    expect(pair.provider).not.toBe("xai/thegreataxios");
    expect(pair.model).not.toBe("xai/thegreataxios");
    expect(pair.provider).toBe("foo");
    expect(pair.model).toBe("bar");
  });
});

describe("initEvalGitRepo", () => {
  const savedGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;

  const restoreGitConfigGlobal = (): void => {
    if (savedGitConfigGlobal === undefined) {
      delete process.env.GIT_CONFIG_GLOBAL;
    } else {
      process.env.GIT_CONFIG_GLOBAL = savedGitConfigGlobal;
    }
  };

  afterEach(() => {
    restoreGitConfigGlobal();
  });

  test("makes a fixture copy a git work tree with a commit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "corbits-eval-git-"));
    try {
      await writeFile(join(dir, "README"), "fixture\n", "utf8");
      await initEvalGitRepo(dir);
      const { stdout } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: dir,
      });
      expect(stdout.trim()).toBe("true");
      const { stdout: head } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir });
      expect(head.trim().length).toBeGreaterThan(0);
      const { stdout: count } = await execFileAsync("git", ["rev-list", "--count", "HEAD"], {
        cwd: dir,
      });
      expect(Number(count.trim())).toBeGreaterThanOrEqual(1);
      const { stdout: log } = await execFileAsync("git", ["log", "-1", "--pretty=%s"], {
        cwd: dir,
      });
      expect(log.trim()).toBe("eval fixture");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("succeeds when the process would otherwise sign", async () => {
    const root = await mkdtemp(join(tmpdir(), "corbits-eval-git-sign-"));
    const work = join(root, "work");
    const configPath = join(root, "gitconfig");
    try {
      await mkdir(work);
      await writeFile(
        configPath,
        "[commit]\ngpgsign = true\n[user]\nsigningkey = DEADKEY\n",
        "utf8",
      );
      process.env.GIT_CONFIG_GLOBAL = configPath;
      await writeFile(join(work, "README"), "fixture\n", "utf8");
      await initEvalGitRepo(work);
      const { stdout: head } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: work });
      expect(head.trim().length).toBeGreaterThan(0);
      const { stdout: cat } = await execFileAsync("git", ["cat-file", "-p", "HEAD"], { cwd: work });
      expect(cat).not.toContain("gpgsig");
    } finally {
      restoreGitConfigGlobal();
      await rm(root, { recursive: true, force: true });
    }
  });
});
