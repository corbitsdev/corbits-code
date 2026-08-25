import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  initEvalGitRepo,
  mapPool,
  parseArgs,
  buildEvalDiagnostics,
  validateVariantEfforts,
} from "./eval-capability.js";
import { parseMatrix } from "../evals/capability/lib.js";
import type { Config } from "../src/config/index.js";

const execFileAsync = promisify(execFile);

function sampleConfig(over: Partial<Config> = {}): Config {
  return {
    configured: true,
    apiKey: "key",
    baseURL: "https://example.test",
    model: "gpt-5",
    providerName: "openai",
    cwd: process.cwd(),
    task: "do it",
    force: true,
    dangerouslySkipPermissions: true,
    skipPermissionsFromSettings: false,
    auto: false,
    command: "exec",
    globalSettingsPath: "/dev/null",
    providers: [],
    sessionId: "sess-1",
    ...over,
  } as Config;
}

describe("parseArgs", () => {
  const savedConcurrency = process.env.CORBITS_EVAL_CONCURRENCY;

  const restoreConcurrency = (): void => {
    if (savedConcurrency === undefined) {
      delete process.env.CORBITS_EVAL_CONCURRENCY;
    } else {
      process.env.CORBITS_EVAL_CONCURRENCY = savedConcurrency;
    }
  };

  afterEach(() => {
    restoreConcurrency();
  });

  beforeEach(() => {
    delete process.env.CORBITS_EVAL_CONCURRENCY;
  });

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

  test("--effort accepts a canonical literal", () => {
    const opts = parseArgs(["--provider", "foo", "--model", "bar", "--effort", "high"]);
    expect(opts.effort).toBe("high");
  });

  test("--effort rejects an unknown literal", () => {
    expect(() => parseArgs(["--provider", "foo", "--model", "bar", "--effort", "bogus"])).toThrow(
      /--effort must be one of/,
    );
  });

  test("--matrix cell can carry its own effort as a third segment", () => {
    const opts = parseArgs(["--matrix", "xai/thegreataxios:grok-4.6:xhigh"]);
    expect(opts.matrix).toBe("xai/thegreataxios:grok-4.6:xhigh");
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

  test("defaults concurrency to 1", () => {
    delete process.env.CORBITS_EVAL_CONCURRENCY;
    const opts = parseArgs(["--provider", "foo", "--model", "bar"]);
    expect(opts.concurrency).toBe(1);
  });

  test("--concurrency 4 is accepted", () => {
    delete process.env.CORBITS_EVAL_CONCURRENCY;
    const opts = parseArgs(["--provider", "foo", "--model", "bar", "--concurrency", "4"]);
    expect(opts.concurrency).toBe(4);
  });

  test("invalid --concurrency values throw", () => {
    const pair = ["--provider", "foo", "--model", "bar"] as const;
    expect(() => parseArgs([...pair, "--concurrency", "0"])).toThrow(/positive integer/);
    expect(() => parseArgs([...pair, "--concurrency", "-1"])).toThrow(/positive integer/);
    expect(() => parseArgs([...pair, "--concurrency", "1.5"])).toThrow(/positive integer/);
    expect(() => parseArgs([...pair, "--concurrency", "foo"])).toThrow(/positive integer/);
  });

  test("CORBITS_EVAL_CONCURRENCY sets the default", () => {
    process.env.CORBITS_EVAL_CONCURRENCY = "3";
    const opts = parseArgs(["--provider", "foo", "--model", "bar"]);
    expect(opts.concurrency).toBe(3);
  });

  test("--concurrency overrides CORBITS_EVAL_CONCURRENCY", () => {
    process.env.CORBITS_EVAL_CONCURRENCY = "8";
    const opts = parseArgs(["--provider", "foo", "--model", "bar", "--concurrency", "2"]);
    expect(opts.concurrency).toBe(2);
  });

  test("invalid CORBITS_EVAL_CONCURRENCY throws", () => {
    process.env.CORBITS_EVAL_CONCURRENCY = "0";
    expect(() => parseArgs(["--provider", "foo", "--model", "bar"])).toThrow(
      /CORBITS_EVAL_CONCURRENCY must be a positive integer/,
    );
  });

  test("--director builder is parsed", () => {
    const opts = parseArgs(["--provider", "foo", "--model", "bar", "--director", "builder"]);
    expect(opts.director).toBe("builder");
  });

  test("omitted --director stays undefined", () => {
    const opts = parseArgs(["--provider", "foo", "--model", "bar"]);
    expect(opts.director).toBeUndefined();
  });

  test("--director without a value throws", () => {
    expect(() => parseArgs(["--provider", "foo", "--model", "bar", "--director"])).toThrow(
      "--director requires a value",
    );
  });
});

describe("validateVariantEfforts", () => {
  // Wiring-level regression: parseArgs -> parseMatrix -> validateVariantEfforts,
  // the same path main() runs before any inference. A matrix cell pairing an
  // effort the model does not accept must fail fast, naming the model and its
  // accepted levels, rather than silently falling back to the provider default
  // and poisoning the matrix.
  test("rejects an unsupported model/effort matrix cell before any inference runs", async () => {
    const opts = parseArgs(["--matrix", "xai/thegreataxios:grok-composer-2.5-fast:xhigh"]);
    const variants = parseMatrix(opts.matrix, {
      ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
    });
    await expect(validateVariantEfforts(variants, opts)).rejects.toThrow(
      /grok-composer-2\.5-fast.*does not support reasoning effort "xhigh".*supported: low, medium, high/s,
    );
  });

  test("accepts a supported model/effort matrix cell", async () => {
    const opts = parseArgs(["--matrix", "xai/thegreataxios:grok-4.6:xhigh"]);
    const variants = parseMatrix(opts.matrix, {
      ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
    });
    await expect(validateVariantEfforts(variants, opts)).resolves.toBeUndefined();
  });
});

describe("mapPool", () => {
  test("N overlapping jobs with concurrency N finish in ~one job duration", async () => {
    const jobMs = 80;
    const n = 4;
    const start = Date.now();
    const results = await mapPool([0, 1, 2, 3], n, async (item) => {
      await new Promise((r) => setTimeout(r, jobMs));
      return item;
    });
    const elapsed = Date.now() - start;
    expect(results).toEqual([0, 1, 2, 3]);
    expect(elapsed).toBeLessThan(jobMs * 2);
    expect(elapsed).toBeGreaterThanOrEqual(jobMs - 20);
  });

  test("preserves input order when later items finish first", async () => {
    const results = await mapPool([1, 2, 3], 3, async (item) => {
      await new Promise((r) => setTimeout(r, (4 - item) * 30));
      return item;
    });
    expect(results).toEqual([1, 2, 3]);
  });

  test("empty input returns an empty array", async () => {
    expect(await mapPool([], 4, async (item) => item)).toEqual([]);
  });

  test("rejects non-positive concurrency", async () => {
    await expect(mapPool([1], 0, async (item) => item)).rejects.toThrow(/positive integer/);
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

describe("buildEvalDiagnostics", () => {
  test("non-Codex provider gets a null instructions hash and the default orchestrator tool list", async () => {
    const diagnostics = await buildEvalDiagnostics(sampleConfig({ providerName: "openai" }));
    expect(diagnostics.codexInstructionsHash).toBeNull();
    expect(diagnostics.advertisedTools).toContain("read_file");
    expect(diagnostics.advertisedTools).toContain("run_shell");
    expect(diagnostics.reasoningEffort).toBeNull();
  });

  test("Codex provider gets a non-null instructions hash", async () => {
    const diagnostics = await buildEvalDiagnostics(sampleConfig({ providerName: "codex/default" }));
    expect(diagnostics.codexInstructionsHash).toMatch(/^[0-9a-f]{12}$/);
  });

  test("echoes back the configured reasoning effort", async () => {
    const diagnostics = await buildEvalDiagnostics(sampleConfig({ reasoningEffort: "high" }));
    expect(diagnostics.reasoningEffort).toBe("high");
  });

  test("--director builder reports the director's own advertised allowlist", async () => {
    const diagnostics = await buildEvalDiagnostics(sampleConfig({ director: "builder" }));
    expect(diagnostics.advertisedTools).not.toEqual(
      (await buildEvalDiagnostics(sampleConfig({}))).advertisedTools,
    );
  });
});
