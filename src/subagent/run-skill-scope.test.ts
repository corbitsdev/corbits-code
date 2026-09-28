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
import { join } from "node:path";

import { withMockedModuleDuring } from "../testkit/mock-module.js";
import {
  workerSkillSearchDefinition,
  type CreateSkillSearchToolArgs,
} from "../agent/skill-search.js";
import { workerUseSkillDefinition } from "../agent/use-skill.js";
import type { RunSubAgentParams } from "./types.js";
import {
  baseRunParams,
  runWithFailingInference,
  tmpSubAgentCwd,
} from "./run-test-harness.js";

type StringTool = {
  kind: string;
  handler: (
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<string>;
};

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

function baseParams(cwd: string, baseURL: string): RunSubAgentParams {
  return baseRunParams(cwd, {
    provider: { providerName: "test", baseURL, model: "test-model" },
    description: "skill scope probe",
    prompt: "no-op",
    allowedSkillNames: ["style"],
  });
}

/** The real skill factories wrapped to record their mount arguments. */
function captureSkillMounts() {
  const captured: {
    searchArgs: CreateSkillSearchToolArgs[];
    useSkillArgs: unknown[][];
    searchTool?: StringTool;
    useSkillTool?: StringTool;
  } = { searchArgs: [], useSkillArgs: [] };

  const withCapturedMounts = <T>(body: () => Promise<T>): Promise<T> =>
    withMockedModuleDuring(
      import.meta.resolve("../agent/skill-search.js"),
      (real: typeof import("../agent/skill-search.js")) => ({
        ...real,
        createSkillSearchTool: (
          args: Parameters<typeof real.createSkillSearchTool>[0],
        ) => {
          captured.searchArgs.push(args);
          const tool = real.createSkillSearchTool(args);
          if (tool.kind !== "string") throw new Error("expected string tool");
          captured.searchTool = tool as StringTool;
          return tool;
        },
      }),
      () =>
        withMockedModuleDuring(
          import.meta.resolve("../agent/use-skill.js"),
          (real: typeof import("../agent/use-skill.js")) => ({
            ...real,
            createUseSkillTool: (...args: unknown[]) => {
              captured.useSkillArgs.push(args);
              const tool = (
                real.createUseSkillTool as (...a: never[]) => unknown
              )(...(args as never[]));
              if (
                typeof tool !== "object" ||
                tool === null ||
                (tool as { kind: string }).kind !== "string"
              )
                throw new Error("expected string tool");
              captured.useSkillTool = tool as StringTool;
              return tool;
            },
          }),
          body,
        ),
    );

  return { captured, withCapturedMounts };
}

async function probeRun(
  cwd: string,
  baseURL: string,
  extra: Partial<RunSubAgentParams> = {},
): Promise<void> {
  const { runSubAgent: run } = await import("./run.js");
  await run({ ...baseParams(cwd, baseURL), ...extra }).catch(() => {
    // Inference fails by design; mount decisions run first.
  });
}

describe("runSubAgent worker skill mounts (CL-7668)", () => {
  test("mounts skill_search + use_skill scoped to allowedSkillNames; out-of-scope names refuse", async () => {
    const cwd = await tmpSubAgentCwd("cl7668-skill-scope-");
    await writeSkill(
      cwd,
      "style",
      "Code style rules.",
      "Follow the style guide.",
    );
    await writeSkill(cwd, "off-lane", "Unrelated lane.", "Off-lane body.");

    const { captured, withCapturedMounts } = captureSkillMounts();
    await runWithFailingInference((baseURL) =>
      withCapturedMounts(() => probeRun(cwd, baseURL)),
    );

    // Both tools mount exactly once, scoped to the dispatch allowlist.
    const searchArgs = captured.searchArgs[0];
    const useSkillArgs = captured.useSkillArgs[0];
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
    const searchTool = captured.searchTool;
    const useSkillTool = captured.useSkillTool;
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
    const cwd = await tmpSubAgentCwd("cl7668-skill-scope-");
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
      const { captured, withCapturedMounts } = captureSkillMounts();
      await runWithFailingInference((baseURL) =>
        withCapturedMounts(async () => {
          const { runSubAgent: run } = await import("./run.js");
          await run({
            ...params,
            cwd,
            workdirBase: join(cwd, ".ctx"),
            provider: { ...params.provider, baseURL },
          }).catch(() => {
            // Inference fails by design; mount decisions run first.
          });
        }),
      );
      return {
        searchCalls: captured.searchArgs.length,
        useSkillCalls: captured.useSkillArgs.length,
      };
    }

    function leafParams(
      providerName: string,
      model: string,
      extra?: Partial<RunSubAgentParams>,
    ): RunSubAgentParams {
      return baseRunParams(cwd, {
        provider: { providerName, baseURL: "http://localhost", model },
        description: "skill deny probe",
        prompt: "no-op",
        allowedSkillNames: ["style"],
        ...extra,
      });
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
    const cwd = await tmpSubAgentCwd("cl7668-skill-scope-");
    const pluginRoot = join(cwd, "plugin");
    await mkdir(join(pluginRoot, "skills", "style"), { recursive: true });
    await writeFile(
      join(pluginRoot, "skills", "style", "SKILL.md"),
      "---\nname: style\ndescription: Code style rules.\n---\n\nFollow the style guide.\n",
    );

    const { captured, withCapturedMounts } = captureSkillMounts();
    await runWithFailingInference((baseURL) =>
      withCapturedMounts(() =>
        probeRun(cwd, baseURL, { skillDirs: [pluginRoot] }),
      ),
    );

    expect(captured.useSkillArgs[0]?.[1]).toEqual([pluginRoot]);
    expect(captured.searchArgs[0]?.skills.map((s) => s.name)).toContain(
      "style",
    );
    const loaded = await captured.useSkillTool?.handler(
      { name: "style" },
      new AbortController().signal,
    );
    expect(loaded).toContain("Follow the style guide.");
  }, 15_000);

  test("threads attachedSkills into use_skill and refuses those names without returning the body", async () => {
    const cwd = await tmpSubAgentCwd("cl7668-skill-scope-");
    await writeSkill(
      cwd,
      "style",
      "Code style rules.",
      "Follow the style guide.",
    );

    const { captured, withCapturedMounts } = captureSkillMounts();
    await runWithFailingInference((baseURL) =>
      withCapturedMounts(() =>
        probeRun(cwd, baseURL, { attachedSkills: ["style"] }),
      ),
    );

    expect(captured.useSkillArgs[0]?.[5]).toEqual(["style"]);
    expect(captured.useSkillTool).toBeDefined();
    const refused = await captured.useSkillTool?.handler(
      { name: "style" },
      new AbortController().signal,
    );
    expect(refused).toBe(
      'Skill "style" is already attached / already in context.',
    );
    expect(refused).not.toContain("Follow the style guide.");
  }, 15_000);

  test("injects attached skill bodies into the worker prompt and notes misses without parking", async () => {
    const cwd = await tmpSubAgentCwd("cl7668-skill-scope-");
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
        () =>
          probeRun(cwd, baseURL, {
            skillDirs: [pluginRoot],
            attachedSkills: ["style", "philosophy"],
          }),
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
