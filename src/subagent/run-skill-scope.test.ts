/**
 * runSubAgent mounts skill_search + use_skill on every worker, scoped to the
 * dispatch's allowedSkillNames (union of attachedSkills and optionalSkills).
 * The scope cannot widen: use_skill refuses names outside the allowlist
 * (CL-6803 stays closed) and skill_search hides them. Plugin skillDirs are
 * threaded through so bundled corbits-skills resolve.
 *
 * Pattern follows run-authority.test.ts: drive the real runSubAgent with
 * failing inference (mount decisions run before the send) while wrapping the
 * real skill factories to capture the mounted tools.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withMockedModuleDuring } from "../../tests/helpers/mock-module.js";
import { createPermissionGate } from "../permission/gate.js";
import {
  workerSkillSearchDefinition,
  type CreateSkillSearchToolArgs,
} from "../agent/skill-search.js";
import { workerUseSkillDefinition } from "../agent/use-skill.js";
import type { RunSubAgentParams } from "./types.js";

const testPermissionGate = createPermissionGate({
  approvals: [],
  interactive: false,
  skipPermissions: true,
  reactorGated: false,
});

async function tmpCwd(): Promise<string> {
  const cwd = join(
    tmpdir(),
    `cl7668-skill-scope-${Date.now()}-${Math.random()}`,
  );
  await mkdir(cwd, { recursive: true });
  return cwd;
}

async function writeSkill(
  cwd: string,
  name: string,
  description: string,
  body: string,
): Promise<void> {
  const dir = join(cwd, ".agents", "skills", name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
  );
}

async function runWithFailingInference(
  run: (baseURL: string) => Promise<unknown>,
): Promise<void> {
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(JSON.stringify({ error: { message: "probe" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
  });
  try {
    await run(server.url.origin);
  } finally {
    server.stop(true);
  }
}

function baseParams(
  cwd: string,
  workdirBase: string,
  baseURL: string,
): RunSubAgentParams {
  return {
    cwd,
    workdirBase,
    permissionGate: testPermissionGate,
    provider: { providerName: "test", baseURL, model: "test-model" },
    description: "skill scope probe",
    prompt: "no-op",
    allowedSkillNames: ["style"],
  };
}

describe("runSubAgent worker skill mounts (CL-7668)", () => {
  test("mounts skill_search + use_skill scoped to allowedSkillNames; out-of-scope names refuse", async () => {
    const cwd = await tmpCwd();
    await writeSkill(
      cwd,
      "style",
      "Code style rules.",
      "Follow the style guide.",
    );
    await writeSkill(cwd, "off-lane", "Unrelated lane.", "Off-lane body.");

    let searchArgs: CreateSkillSearchToolArgs | undefined;
    let useSkillArgs: readonly unknown[] | undefined;
    let searchTool:
      | {
          kind: string;
          handler: (
            args: Record<string, unknown>,
            signal: AbortSignal,
          ) => Promise<string>;
        }
      | undefined;
    let useSkillTool:
      | {
          kind: string;
          handler: (
            args: Record<string, unknown>,
            signal: AbortSignal,
          ) => Promise<string>;
        }
      | undefined;

    await runWithFailingInference((baseURL) =>
      withMockedModuleDuring(
        import.meta.resolve("../agent/skill-search.js"),
        (real: typeof import("../agent/skill-search.js")) => ({
          ...real,
          createSkillSearchTool: (
            args: Parameters<typeof real.createSkillSearchTool>[0],
          ) => {
            searchArgs = args;
            const tool = real.createSkillSearchTool(args);
            if (tool.kind !== "string") throw new Error("expected string tool");
            searchTool = tool as typeof searchTool & {};
            return tool;
          },
        }),
        () =>
          withMockedModuleDuring(
            import.meta.resolve("../agent/use-skill.js"),
            (real: typeof import("../agent/use-skill.js")) => ({
              ...real,
              createUseSkillTool: (...args: unknown[]) => {
                useSkillArgs = args;
                const tool = (
                  real.createUseSkillTool as (...a: never[]) => unknown
                )(...(args as never[]));
                if (
                  typeof tool !== "object" ||
                  tool === null ||
                  (tool as { kind: string }).kind !== "string"
                )
                  throw new Error("expected string tool");
                useSkillTool = tool as typeof useSkillTool & {};
                return tool;
              },
            }),
            async () => {
              const { runSubAgent: run } = await import("./run.js");
              await run(baseParams(cwd, join(cwd, ".ctx"), baseURL)).catch(
                () => {
                  // Inference fails by design; mount decisions run first.
                },
              );
            },
          ),
      ),
    );

    // Both tools mount exactly once, scoped to the dispatch allowlist.
    expect(searchArgs).toBeDefined();
    expect(searchArgs?.allowedNames).toEqual(["style"]);
    expect(searchArgs?.skills.map((s) => s.name).sort()).toEqual([
      "off-lane",
      "style",
    ]);
    expect(useSkillArgs?.[0]).toBe(cwd);
    expect(useSkillArgs?.[1]).toEqual([]);
    expect(useSkillArgs?.[3]).toEqual(["style"]);
    expect(searchArgs?.definition).toBe(workerSkillSearchDefinition);
    expect(useSkillArgs?.[4]).toBe(workerUseSkillDefinition);
    expect(searchTool).toBeDefined();
    expect(useSkillTool).toBeDefined();

    const signal = new AbortController().signal;
    // In-scope skill loads.
    const loaded = await useSkillTool?.handler({ name: "style" }, signal);
    expect(loaded).toContain('Skill "style"');
    expect(loaded).toContain("Follow the style guide.");
    const found = await searchTool?.handler({ query: "style" }, signal);
    expect(found).toContain("- style: Code style rules.");

    // Out-of-scope names refuse — CL-6803 stays closed.
    expect(await useSkillTool?.handler({ name: "off-lane" }, signal)).toBe(
      'No skill named "off-lane" is available.',
    );
    expect(await searchTool?.handler({ query: "off-lane" }, signal)).toBe(
      'No skills matched "off-lane". Try different keywords describing the capability.',
    );
  }, 15_000);

  test("grok/kimi leaves mount skill_search and use_skill like every other family", async () => {
    const cwd = await tmpCwd();
    await writeSkill(
      cwd,
      "style",
      "Code style rules.",
      "Follow the style guide.",
    );

    async function runCase(params: RunSubAgentParams): Promise<{
      searchCalls: number;
      useSkillCalls: number;
    }> {
      let searchCalls = 0;
      let useSkillCalls = 0;
      await runWithFailingInference((baseURL) =>
        withMockedModuleDuring(
          import.meta.resolve("../agent/skill-search.js"),
          (real: typeof import("../agent/skill-search.js")) => ({
            ...real,
            createSkillSearchTool: (
              args: Parameters<typeof real.createSkillSearchTool>[0],
            ) => {
              searchCalls += 1;
              return real.createSkillSearchTool(args);
            },
          }),
          () =>
            withMockedModuleDuring(
              import.meta.resolve("../agent/use-skill.js"),
              (real: typeof import("../agent/use-skill.js")) => ({
                ...real,
                createUseSkillTool: (...args: unknown[]) => {
                  useSkillCalls += 1;
                  return (
                    real.createUseSkillTool as (...a: never[]) => unknown
                  )(...(args as never[]));
                },
              }),
              async () => {
                const { runSubAgent: run } = await import("./run.js");
                await run({
                  ...params,
                  cwd,
                  workdirBase: join(cwd, ".ctx"),
                  provider: { ...params.provider, baseURL },
                }).catch(() => {
                  // Inference fails by design; mount decisions run first.
                });
              },
            ),
        ),
      );
      return { searchCalls, useSkillCalls };
    }

    function leafParams(
      providerName: string,
      model: string,
      extra?: Partial<RunSubAgentParams>,
    ): RunSubAgentParams {
      return {
        cwd,
        workdirBase: join(cwd, ".ctx"),
        permissionGate: testPermissionGate,
        provider: { providerName, baseURL: "http://localhost", model },
        description: "skill deny probe",
        prompt: "no-op",
        allowedSkillNames: ["style"],
        ...extra,
      };
    }

    // Grok + kimi leaves: both mount — orchestrator vs leaf no longer differs
    // for skill_search.
    for (const [providerName, model] of [
      ["xai", "grok-4-1-fast-non-reasoning"],
      ["moonshot", "kimi-k2-0711"],
    ] as const) {
      const counts = await runCase(leafParams(providerName, model));
      expect({ providerName, ...counts }).toEqual({
        providerName,
        searchCalls: 1,
        useSkillCalls: 1,
      });
    }

    // Default family leaf: both mount (existing behavior unchanged).
    expect(await runCase(leafParams("test", "test-model"))).toEqual({
      searchCalls: 1,
      useSkillCalls: 1,
    });

    // Grok orchestrator: both still mount.
    expect(
      await runCase(
        leafParams("xai", "grok-4-1-fast-non-reasoning", {
          orchestrator: true,
        }),
      ),
    ).toEqual({ searchCalls: 1, useSkillCalls: 1 });
  }, 30_000);

  test("plugin skillDirs reach use_skill and discoverSkills so bundled-style skills resolve", async () => {
    const cwd = await tmpCwd();
    const pluginRoot = join(cwd, "plugin");
    await mkdir(join(pluginRoot, "skills", "style"), { recursive: true });
    await writeFile(
      join(pluginRoot, "skills", "style", "SKILL.md"),
      "---\nname: style\ndescription: Code style rules.\n---\n\nFollow the style guide.\n",
    );

    let useSkillArgs: readonly unknown[] | undefined;
    let searchArgs: CreateSkillSearchToolArgs | undefined;
    let useSkillTool:
      | {
          kind: string;
          handler: (
            args: Record<string, unknown>,
            signal: AbortSignal,
          ) => Promise<string>;
        }
      | undefined;

    await runWithFailingInference((baseURL) =>
      withMockedModuleDuring(
        import.meta.resolve("../agent/skill-search.js"),
        (real: typeof import("../agent/skill-search.js")) => ({
          ...real,
          createSkillSearchTool: (
            args: Parameters<typeof real.createSkillSearchTool>[0],
          ) => {
            searchArgs = args;
            return real.createSkillSearchTool(args);
          },
        }),
        () =>
          withMockedModuleDuring(
            import.meta.resolve("../agent/use-skill.js"),
            (real: typeof import("../agent/use-skill.js")) => ({
              ...real,
              createUseSkillTool: (...args: unknown[]) => {
                useSkillArgs = args;
                const tool = (
                  real.createUseSkillTool as (...a: never[]) => unknown
                )(...(args as never[]));
                if (
                  typeof tool !== "object" ||
                  tool === null ||
                  (tool as { kind: string }).kind !== "string"
                )
                  throw new Error("expected string tool");
                useSkillTool = tool as typeof useSkillTool & {};
                return tool;
              },
            }),
            async () => {
              const { runSubAgent: run } = await import("./run.js");
              await run({
                ...baseParams(cwd, join(cwd, ".ctx"), baseURL),
                skillDirs: [pluginRoot],
              }).catch(() => {
                // Inference fails by design; mount decisions run first.
              });
            },
          ),
      ),
    );

    expect(useSkillArgs?.[1]).toEqual([pluginRoot]);
    expect(searchArgs?.skills.map((s) => s.name)).toContain("style");
    const loaded = await useSkillTool?.handler(
      { name: "style" },
      new AbortController().signal,
    );
    expect(loaded).toContain("Follow the style guide.");
  }, 15_000);

  test("threads attachedSkills into use_skill and refuses those names without returning the body", async () => {
    const cwd = await tmpCwd();
    await writeSkill(
      cwd,
      "style",
      "Code style rules.",
      "Follow the style guide.",
    );

    let useSkillArgs: readonly unknown[] | undefined;
    let useSkillTool:
      | {
          kind: string;
          handler: (
            args: Record<string, unknown>,
            signal: AbortSignal,
          ) => Promise<string>;
        }
      | undefined;

    await runWithFailingInference((baseURL) =>
      withMockedModuleDuring(
        import.meta.resolve("../agent/use-skill.js"),
        (real: typeof import("../agent/use-skill.js")) => ({
          ...real,
          createUseSkillTool: (...args: unknown[]) => {
            useSkillArgs = args;
            const tool = (
              real.createUseSkillTool as (...a: never[]) => unknown
            )(...(args as never[]));
            if (
              typeof tool !== "object" ||
              tool === null ||
              (tool as { kind: string }).kind !== "string"
            )
              throw new Error("expected string tool");
            useSkillTool = tool as typeof useSkillTool & {};
            return tool;
          },
        }),
        async () => {
          const { runSubAgent: run } = await import("./run.js");
          await run({
            ...baseParams(cwd, join(cwd, ".ctx"), baseURL),
            attachedSkills: ["style"],
          }).catch(() => {
            // Inference fails by design; mount decisions run first.
          });
        },
      ),
    );

    expect(useSkillArgs?.[5]).toEqual(["style"]);
    expect(useSkillTool).toBeDefined();
    const refused = await useSkillTool?.handler(
      { name: "style" },
      new AbortController().signal,
    );
    expect(refused).toBe(
      'Skill "style" is already attached / already in context.',
    );
    expect(refused).not.toContain("Follow the style guide.");
  }, 15_000);

  test("injects attached skill bodies into the worker prompt and notes misses without parking", async () => {
    const cwd = await tmpCwd();
    const pluginRoot = join(cwd, "plugin");
    await mkdir(join(pluginRoot, "skills", "style"), { recursive: true });
    await writeFile(
      join(pluginRoot, "skills", "style", "SKILL.md"),
      "---\nname: style\ndescription: Code style rules.\n---\n\nFollow the style guide.\n",
    );

    let extensions: readonly string[] | undefined;

    await runWithFailingInference((baseURL) =>
      withMockedModuleDuring(
        import.meta.resolve("../agent/prompts.js"),
        (real: typeof import("../agent/prompts.js")) => ({
          ...real,
          buildSubAgentSystemPrompt: (
            ext: readonly string[] | undefined,
            ...rest: unknown[]
          ) => {
            extensions = ext;
            return (
              real.buildSubAgentSystemPrompt as (
                ...a: never[]
              ) => ReturnType<typeof real.buildSubAgentSystemPrompt>
            )(ext as never, ...(rest as never[]));
          },
        }),
        async () => {
          const { runSubAgent: run } = await import("./run.js");
          await run({
            ...baseParams(cwd, join(cwd, ".ctx"), baseURL),
            skillDirs: [pluginRoot],
            attachedSkills: ["style", "philosophy"],
          }).catch(() => {
            // Inference fails by design; prompt assembly runs first.
          });
        },
      ),
    );

    const joined = (extensions ?? []).join("\n");
    expect(joined).toContain("# Attached skill constraints");
    expect(joined).toContain("Do not use_skill them again");
    expect(joined).toContain("do not park, do not ask_director");
    expect(joined).toContain("### style");
    expect(joined).toContain("Follow the style guide.");
    expect(joined).toContain(
      'Attached skill "philosophy" could not be resolved. Proceed under AGENTS.md.',
    );
    expect(joined).not.toContain("### philosophy");
  }, 15_000);
});
