/**
 * Spawn cold start: fleet workers reuse the dispatcher's already-paid
 * init work — the parent skill catalog, the inference deps + pricing seed,
 * and the short-TTL environment snapshot — instead of re-running discovery,
 * git, and the pricing seed per lane. Spawn dispatch itself stays
 * non-blocking: every reuse lookup on the dispatch path is a sync
 * cache/reference handoff.
 *
 * Pattern follows run-skill-scope.test.ts (real runSubAgent against the
 * failing local provider; mount decisions run before the send) and
 * run-authority.test.ts (re-import run.js inside the module mock).
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { withMockedModuleDuring } from "../../testkit/mock-module.js";
import { defined } from "../../testkit/defined.js";
import { initTemporaryGitRepo } from "../../testkit/temporary-git-repo.js";
import {
  discoverSkillsCached,
  resetSkillDiscoveryCacheForTests,
} from "../extensions/skills.js";
import {
  gatherEnvironmentCached,
  resetEnvironmentCacheForTests,
} from "../agent/environment.js";
import { createSpawnAgentTool } from "./agent-fleet.js";
import type { RunSubAgentParams, RunSubAgentResult } from "./types.js";
import {
  callFleetTool,
  createFleetDeps,
  deferred,
  spawnAgentId,
} from "./fleet-test-harness.js";
import { testPermissionGate } from "./fleet-test-harness.js";
import {
  baseRunParams,
  pollUntil,
  runWithFailingInference,
  tmpSubAgentCwd,
} from "./run-test-harness.js";

const tempDirs: string[] = [];

const runGit = promisify(execFile);

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  resetSkillDiscoveryCacheForTests();
  resetEnvironmentCacheForTests();
});

async function writeSkillFile(
  pluginDir: string,
  name: string,
  description: string,
): Promise<void> {
  await mkdir(join(pluginDir, "skills", name), { recursive: true });
  await writeFile(
    join(pluginDir, "skills", name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`,
  );
}

function probeParams(
  cwd: string,
  baseURL: string,
  extra: Partial<RunSubAgentParams> = {},
): RunSubAgentParams {
  return baseRunParams(cwd, {
    provider: { providerName: "test", baseURL, model: "test-model" },
    description: "cold start probe",
    prompt: "no-op",
    ...extra,
  });
}

/** Drive the real runSubAgent under the failing provider; init decisions run
 * before the send fails. run.js is re-imported so module mocks are visible
 * to its bindings. */
async function probeRun(
  cwd: string,
  baseURL: string,
  extra: Partial<RunSubAgentParams> = {},
): Promise<void> {
  const { runSubAgent: run } = await import("./run.js");
  await run(probeParams(cwd, baseURL, extra)).catch(() => {
    // Inference fails by design; init decisions run first.
  });
}

/** Wrap createSkillSearchTool to record the catalog each run mounts. */
function captureSearchCatalog() {
  const catalogs: { name: string; description: string }[][] = [];
  const withCapturedCatalog = <T>(body: () => Promise<T>): Promise<T> =>
    withMockedModuleDuring(
      import.meta.resolve("../agent/skill-search.js"),
      (real: typeof import("../agent/skill-search.js")) => ({
        ...real,
        createSkillSearchTool: (
          args: Parameters<typeof real.createSkillSearchTool>[0],
        ) => {
          catalogs.push([...args.skills]);
          return real.createSkillSearchTool(args);
        },
      }),
      body,
    );
  return { catalogs, withCapturedCatalog };
}

describe("CL-9010 skill snapshot cache", () => {
  test("same-cwd second lookup skips rediscovery", async () => {
    const cwd = await tempDir("cl9010-skill-cache-");
    const plugin = join(cwd, "plugin");
    await writeSkillFile(plugin, "alpha", "Alpha skill.");
    expect(
      (await discoverSkillsCached(cwd, [plugin])).map((s) => s.name),
    ).toEqual(["alpha"]);
    await rm(join(plugin, "skills", "alpha"), { recursive: true, force: true });
    expect(
      (await discoverSkillsCached(cwd, [plugin])).map((s) => s.name),
    ).toEqual(["alpha"]);
  });

  test("different skill dirs respawn discovery", async () => {
    const cwd = await tempDir("cl9010-skill-dirs-");
    const pluginA = join(cwd, "a");
    const pluginB = join(cwd, "b");
    await writeSkillFile(pluginA, "alpha", "Alpha skill.");
    await mkdir(join(pluginB, "skills"), { recursive: true });
    expect(
      (await discoverSkillsCached(cwd, [pluginA])).map((s) => s.name),
    ).toEqual(["alpha"]);
    expect(await discoverSkillsCached(cwd, [pluginB])).toEqual([]);
  });

  test("a different cwd rediscovers even with the same dirs", async () => {
    const root = await tempDir("cl9010-skill-cwd-");
    const shared = join(root, "shared");
    await writeSkillFile(shared, "alpha", "Alpha skill.");
    const cwdA = join(root, "lane-a");
    const cwdB = join(root, "lane-b");
    await mkdir(join(cwdA, ".agents", "skills", "local-a"), {
      recursive: true,
    });
    await writeFile(
      join(cwdA, ".agents", "skills", "local-a", "SKILL.md"),
      "---\nname: local-a\ndescription: Lane A skill.\n---\n\nBody.\n",
    );
    await mkdir(cwdB, { recursive: true });
    expect(
      (await discoverSkillsCached(cwdA, [shared])).map((s) => s.name).sort(),
    ).toEqual(["alpha", "local-a"]);
    expect(
      (await discoverSkillsCached(cwdB, [shared])).map((s) => s.name),
    ).toEqual(["alpha"]);
  });

  test("callers get isolated copies — no cross-session leakage", async () => {
    const cwd = await tempDir("cl9010-skill-isolation-");
    const plugin = join(cwd, "plugin");
    await writeSkillFile(plugin, "alpha", "Alpha skill.");
    const first = await discoverSkillsCached(cwd, [plugin]);
    first.push({ name: "injected", description: "must not leak" });
    defined(first[0], "cached skill").description = "mutated";
    const second = await discoverSkillsCached(cwd, [plugin]);
    expect(second).toEqual([{ name: "alpha", description: "Alpha skill." }]);
    expect(second).not.toBe(first);
  });
});

describe("CL-9010 environment snapshot cache", () => {
  test("reuses the snapshot within the TTL and refetches after expiry", async () => {
    const cwd = await tempDir("cl9010-env-cache-");
    await writeFile(join(cwd, "first.txt"), "first");
    const first = await gatherEnvironmentCached(cwd);
    expect(first.topLevel).toContain("first.txt");
    await writeFile(join(cwd, "second.txt"), "second");
    const cached = await gatherEnvironmentCached(cwd);
    expect(cached.topLevel).toBe(first.topLevel);
    expect(cached.topLevel).not.toContain("second.txt");
    const refetched = await gatherEnvironmentCached(cwd, new Date(), 0);
    expect(refetched.topLevel).toContain("second.txt");
  });

  test("hits return isolated copies stamped with a fresh date", async () => {
    const cwd = await tempDir("cl9010-env-isolation-");
    const dayOne = new Date("2026-01-01T00:00:00Z");
    const dayTwo = new Date("2026-06-01T00:00:00Z");
    const first = await gatherEnvironmentCached(cwd, dayOne);
    first.platform = "mutated";
    const second = await gatherEnvironmentCached(cwd, dayTwo);
    expect(second.platform).not.toBe("mutated");
    expect(second.date).toEqual(dayTwo);
  });
});

describe("CL-9010 fleet dispatch threading", () => {
  function captureRun(onParams: (params: RunSubAgentParams) => void): {
    gate: ReturnType<typeof deferred<RunSubAgentResult>>;
    run: (params: RunSubAgentParams) => Promise<RunSubAgentResult>;
  } {
    const gate = deferred<RunSubAgentResult>();
    return {
      gate,
      run: async (params: RunSubAgentParams) => {
        onParams(params);
        params.onAgentReady?.({
          close: async () => undefined,
          interrupt: () => undefined,
          followup: async () => "",
          deliver: () => undefined,
        });
        return gate.promise;
      },
    };
  }

  async function spawnExploreAndCapture(opts: {
    cwd: string;
    skillSnapshot?: { name: string; description: string }[];
    useWorktree?: boolean;
    getWorkdirBase?: () => string;
  }): Promise<RunSubAgentParams> {
    let captured: RunSubAgentParams | undefined;
    const { gate, run } = captureRun((params) => {
      captured = params;
    });
    const deps = createFleetDeps(run, { cwd: opts.cwd });
    if (opts.skillSnapshot !== undefined)
      deps.skillSnapshot = opts.skillSnapshot;
    if (opts.useWorktree === true) deps.useWorktree = true;
    if (opts.getWorkdirBase !== undefined)
      deps.getWorkdirBase = opts.getWorkdirBase;
    const spawn = createSpawnAgentTool(deps);
    const id = await spawnAgentId(spawn, {
      description: "cold start lane",
      prompt: "do it",
      intent: "explore",
    });
    expect(typeof id).toBe("string");
    await pollUntil(() => captured !== undefined, {
      message: "worker run never started",
    });
    gate.resolve({ report: "done" });
    return defined(captured, "captured run params");
  }

  test("shared-cwd lanes inherit the parent snapshot and skip the pricing seed", async () => {
    const snapshot = [{ name: "style", description: "Style rules." }];
    const params = await spawnExploreAndCapture({
      cwd: "/repo",
      skillSnapshot: snapshot,
    });
    expect(params.skills).toEqual(snapshot);
    expect(params.skipPricingSeed).toBe(true);
  });

  test("lanes without a parent snapshot discover on their own but still skip the seed", async () => {
    const params = await spawnExploreAndCapture({ cwd: "/repo" });
    expect(params.skills).toBeUndefined();
    expect(params.skipPricingSeed).toBe(true);
  });

  test("worktree lanes ignore the parent snapshot — their cwd differs", async () => {
    const repo = await tempDir("cl9010-fleet-wt-");
    initTemporaryGitRepo(repo);
    await writeFile(join(repo, "seed.txt"), "seed");
    await runGit("git", ["add", "."], { cwd: repo });
    await runGit("git", ["commit", "-m", "seed"], { cwd: repo });
    const base = await tempDir("cl9010-fleet-wt-base-");
    const snapshot = [{ name: "style", description: "Style rules." }];
    const params = await spawnExploreAndCapture({
      cwd: repo,
      skillSnapshot: snapshot,
      useWorktree: true,
      getWorkdirBase: () => base,
    });
    expect(params.cwd).not.toBe(repo);
    expect(params.skills).toBeUndefined();
    expect(params.skipPricingSeed).toBe(true);
  });
});

describe("CL-9010 run-level reuse", () => {
  test("params.skills bypasses discovery entirely", async () => {
    const cwd = await tmpSubAgentCwd("cl9010-run-bypass-");
    const { catalogs, withCapturedCatalog } = captureSearchCatalog();
    await runWithFailingInference((baseURL) =>
      withCapturedCatalog(() =>
        probeRun(cwd, baseURL, {
          skills: [{ name: "handed-down", description: "From the parent." }],
        }),
      ),
    );
    expect(catalogs.length).toBe(1);
    expect(defined(catalogs[0])).toEqual([
      { name: "handed-down", description: "From the parent." },
    ]);
  }, 30_000);

  test("same-cwd second spawn skips rediscovery; different dirs respawn", async () => {
    const cwd = await tmpSubAgentCwd("cl9010-run-respawn-");
    const pluginA = join(cwd, "plugin-a");
    const pluginB = join(cwd, "plugin-b");
    await writeSkillFile(pluginA, "alpha", "Alpha skill.");
    await mkdir(join(pluginB, "skills"), { recursive: true });
    const { catalogs, withCapturedCatalog } = captureSearchCatalog();
    await runWithFailingInference((baseURL) =>
      withCapturedCatalog(() =>
        probeRun(cwd, baseURL, { skillDirs: [pluginA] }),
      ),
    );
    expect(defined(catalogs[0]).map((s) => s.name)).toEqual(["alpha"]);
    await rm(join(pluginA, "skills", "alpha"), {
      recursive: true,
      force: true,
    });
    await runWithFailingInference((baseURL) =>
      withCapturedCatalog(() =>
        probeRun(cwd, baseURL, { skillDirs: [pluginA] }),
      ),
    );
    expect(defined(catalogs[1]).map((s) => s.name)).toEqual(["alpha"]);
    await runWithFailingInference((baseURL) =>
      withCapturedCatalog(() =>
        probeRun(cwd, baseURL, { skillDirs: [pluginB] }),
      ),
    );
    expect(defined(catalogs[2])).toEqual([]);
  }, 60_000);

  test("the second same-cwd spawn reuses the snapshot instead of re-gathering", async () => {
    const cwd = await tmpSubAgentCwd("cl9010-run-env-");
    let uncachedCalls = 0;
    await runWithFailingInference((baseURL) =>
      withMockedModuleDuring(
        import.meta.resolve("../agent/environment.js"),
        (real: typeof import("../agent/environment.js")) => ({
          ...real,
          gatherEnvironment: (
            ...args: Parameters<typeof real.gatherEnvironment>
          ) => {
            uncachedCalls += 1;
            return real.gatherEnvironment(...args);
          },
        }),
        async () => {
          const { runSubAgent: run } = await import("./run.js");
          // First spawn pays the gather and populates the cache...
          await run(probeParams(cwd, baseURL)).catch(() => undefined);
          expect(uncachedCalls).toBe(1);
          // ...the second same-cwd spawn reuses it with no re-gather.
          await run(probeParams(cwd, baseURL)).catch(() => undefined);
          expect(uncachedCalls).toBe(1);
        },
      ),
    );
  }, 60_000);

  test("skipPricingSeed skips the seed read; without it the seed runs", async () => {
    const cwd = await tmpSubAgentCwd("cl9010-run-seed-");
    const seedCalls: unknown[][] = [];
    await runWithFailingInference((baseURL) =>
      withMockedModuleDuring(
        import.meta.resolve("../cost/pricing-metadata.js"),
        (real: typeof import("../cost/pricing-metadata.js")) => ({
          ...real,
          seedPricingMetadataFromCache: (
            ...args: Parameters<typeof real.seedPricingMetadataFromCache>
          ) => {
            seedCalls.push(args);
            return real.seedPricingMetadataFromCache(...args);
          },
        }),
        async () => {
          const { runSubAgent: run } = await import("./run.js");
          await run(probeParams(cwd, baseURL)).catch(() => undefined);
          expect(seedCalls.length).toBeGreaterThan(0);
          seedCalls.length = 0;
          await run(probeParams(cwd, baseURL, { skipPricingSeed: true })).catch(
            () => undefined,
          );
          expect(seedCalls).toEqual([]);
        },
      ),
    );
  }, 60_000);

  test("orchestrator lanes hand their catalog to nested dispatch", async () => {
    const cwd = await tmpSubAgentCwd("cl9010-run-nested-");
    await writeSkillFile(join(cwd, "plugin"), "alpha", "Alpha skill.");
    const seen: unknown[] = [];
    await runWithFailingInference((baseURL) =>
      withMockedModuleDuring(
        import.meta.resolve("./agent-fleet.js"),
        (real: typeof import("./agent-fleet.js")) => ({
          ...real,
          createSpawnAgentTool: (
            deps: Parameters<typeof real.createSpawnAgentTool>[0],
          ) => {
            seen.push(deps);
            return real.createSpawnAgentTool(deps);
          },
        }),
        async () => {
          const { runSubAgent: run } = await import("./run.js");
          await run(
            probeParams(cwd, baseURL, {
              orchestrator: true,
              orchestratorTier: "nested-orchestrator",
              skillDirs: [join(cwd, "plugin")],
              nestedDispatch: {
                permissionGate: testPermissionGate,
                getWorkdirBase: () => join(cwd, ".ctx"),
                provider: {
                  providerName: "test",
                  baseURL,
                  model: "test-model",
                },
              },
            }),
          ).catch(() => undefined);
        },
      ),
    );
    expect(seen.length).toBeGreaterThan(0);
    const nested = defined(seen[0]) as {
      skillSnapshot?: { name: string }[];
    };
    expect(nested.skillSnapshot?.map((s) => s.name)).toContain("alpha");
  }, 30_000);
});

describe("CL-9010 spawn dispatch stays non-blocking", () => {
  test("the handler returns while the worker run is still pending", async () => {
    const gate = deferred<RunSubAgentResult>();
    const deps = createFleetDeps(async (params) => {
      params.onAgentReady?.({
        close: async () => undefined,
        interrupt: () => undefined,
        followup: async () => "",
        deliver: () => undefined,
      });
      return gate.promise;
    });
    deps.skillSnapshot = [{ name: "style", description: "Style rules." }];
    const spawn = createSpawnAgentTool(deps);
    const result = await callFleetTool(spawn, {
      description: "cold start lane",
      prompt: "do it",
      intent: "explore",
    });
    // The gate is still unresolved here: dispatch returned first.
    expect(result.status).toBe("running");
    gate.resolve({ report: "done" });
  });
});
