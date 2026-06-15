import { join } from "node:path";

import {
  createAgent,
  defineAgent,
  defineTool,
  createToolRunner,
  createDirectorRegistry,
  defineDirector,
  fromToolRunner,
  stringTool,
} from "@intx/agent";
import type { AgentTool } from "@intx/agent";
import { noopAuditStore, permissiveAuthorize } from "@intx/agent/testing";
import { createIsogitStore } from "@intx/storage-isogit";
import { type } from "arktype";
import { createPosixTools } from "@intx/tools-posix";
import { createLSPPlugin } from "@intx/tools-lsp";
import { DefaultDirector } from "@intx/inference";
import type {
  ReactorInboundEvent,
  ReactorState,
  ReactorCapabilities,
  ReactorAction,
  ToolDefinition,
} from "@intx/types/runtime";

import { buildOpenAISource } from "../config/index.js";
import type { ReasoningEffort } from "../provider/reasoning-effort.js";
import { pathEscapePlugin } from "../plugins/path-escape-plugin.js";
import { secretGuardPlugin } from "../plugins/secret-guard-plugin.js";
import { authzPlugin } from "../plugins/authz-plugin.js";
import { ripgrepPlugin } from "../plugins/ripgrep-plugin.js";
import { verifyPlugin } from "../plugins/verify-plugin.js";
import { webToolsPlugin } from "../web/plugin.js";
import { buildSubAgentSystemPrompt } from "../agent/prompts.js";
import { gatherEnvironment } from "../agent/environment.js";
import { generateSessionId } from "../session/index.js";
import { consumeStream } from "../session/stream-consumer.js";
import type { CapabilityFilter, AgentProfile } from "../agent/profiles.js";
import type { Settings, ProviderTier } from "../config/settings.js";
import { resolveTier } from "../config/settings.js";

// A sub-agent is a worker, not a chat partner: it runs until it stops calling
// tools, at which point its final assistant text is the result handed back to
// the dispatcher. It has no submit_plan/submit_output and never blocks on the
// operator — autonomy is the whole point of delegation.
const SUBAGENT_DEFAULT_MAX_TURNS = 25;

function lastText(content: ReadonlyArray<{ type: string }>): string {
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i] as { type: string; text?: string };
    if (block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }
  return "";
}

class SubAgentDirector extends DefaultDirector {
  private turns = 0;
  private readonly maxTurns: number;

  constructor(systemPrompt: string, toolDefinitions: ToolDefinition[], maxTurns: number) {
    super(systemPrompt, toolDefinitions, {});
    this.maxTurns = maxTurns;
  }

  override async decide(
    event: ReactorInboundEvent,
    state: ReactorState,
    capabilities: ReactorCapabilities,
  ): Promise<ReactorAction | ReactorAction[]> {
    if (event.type === "inference.done") {
      this.turns++;
      const hasToolCalls = event.turn.content.some((b) => b.type === "tool_call");
      if (!hasToolCalls) {
        return [
          capabilities.checkpoint("subagent-complete"),
          capabilities.reply(lastText(event.turn.content)),
        ];
      }
      if (this.turns >= this.maxTurns) {
        return [
          capabilities.checkpoint("subagent-max-turns"),
          capabilities.reply(
            `Sub-agent stopped after reaching its ${this.maxTurns}-turn limit. Partial progress may have landed in the working tree.`,
          ),
        ];
      }
    }
    return super.decide(event, state, capabilities);
  }
}

export type SubAgentProvider = {
  providerName: string;
  baseURL: string;
  apiKey: string;
  model: string;
  // Subagents inherit the parent's reasoning effort so a /agent selection
  // applies to delegated work, not just the top-level loop.
  reasoningEffort?: ReasoningEffort;
};

export type RunSubAgentParams = {
  cwd: string;
  workdirBase: string;
  provider: SubAgentProvider;
  description: string;
  context?: string;
  prompt: string;
  maxTurns?: number;
  signal?: AbortSignal;
  onEvent?: (event: import("@intx/inference").ReactorEmittedEvent) => void;
  capabilities?: CapabilityFilter;
  systemPromptRole?: string;
};

function applyCapabilityFilter(tools: AgentTool[], capabilities: CapabilityFilter): AgentTool[] {
  const nameSet = new Set(capabilities.tools);
  if (capabilities.mode === "exclude") {
    return tools.filter((t) => !nameSet.has(t.definition.name));
  }
  return tools.filter((t) => nameSet.has(t.definition.name));
}

// Spin up an isolated, autonomous agent loop against the same working tree,
// hand it one task, and return its final report. The sub-agent shares the
// dispatcher's cwd so its edits land in the real repo, but gets its own posix
// tool instances and its own git-backed context store so the two loops never
// trample each other's state.
export async function runSubAgent(params: RunSubAgentParams): Promise<string> {
  const maxTurns = params.maxTurns ?? SUBAGENT_DEFAULT_MAX_TURNS;
  const posixTools = createPosixTools({
    cwd: params.cwd,
    plugins: [
      pathEscapePlugin(params.cwd),
      secretGuardPlugin(),
      authzPlugin(),
      ripgrepPlugin(params.cwd),
      verifyPlugin(),
      webToolsPlugin(),
      createLSPPlugin({ cwd: params.cwd, minSeverity: 1 }),
    ],
  });
  let tools = fromToolRunner(posixTools);

  if (params.capabilities !== undefined) {
    tools = applyCapabilityFilter(tools, params.capabilities);
  }

  const environment = await gatherEnvironment(params.cwd);
  const extensions =
    params.systemPromptRole !== undefined ? [params.systemPromptRole] : undefined;
  const systemPrompt = buildSubAgentSystemPrompt(extensions, environment);

  const directorDef = defineDirector({
    id: "intercode/subagent",
    configSchema: type({}),
    factory: (_config, _env, agentCtx) =>
      new SubAgentDirector(agentCtx.systemPrompt, [...agentCtx.toolDefinitions], maxTurns),
  });

  const toolsFactory = defineTool({
    id: "intercode/subagent-tools",
    factory: () => createToolRunner(tools),
  });

  const workdir = join(params.workdirBase, "subagents", generateSessionId());

  const def = defineAgent({
    id: "intercode/subagent",
    systemPrompt,
    tools: [toolsFactory],
    capabilities: [],
    director: directorDef.build({}),
    inference: {
      sources: [{ provider: params.provider.providerName, model: params.provider.model }],
    },
  });

  const storage = await createIsogitStore(workdir);

  const agent = await createAgent(def, {
    source: buildOpenAISource({
      id: params.provider.providerName,
      baseURL: params.provider.baseURL,
      apiKey: params.provider.apiKey,
      model: params.provider.model,
      ...(params.provider.reasoningEffort !== undefined
        ? { reasoningEffort: params.provider.reasoningEffort }
        : {}),
    }),
    storage,
    workdir,
    audit: noopAuditStore(),
    authorize: permissiveAuthorize(),
    directors: createDirectorRegistry({
      factories: [directorDef.factory],
      defaultId: "intercode/subagent",
    }),
  });

  const streamPromise =
    params.onEvent !== undefined
      ? consumeStream(agent.stream(), params.onEvent)
      : Promise.resolve();

  try {
    const fullPrompt = params.context
      ? `${params.description}\n\n## Context\n${params.context}\n\n## Task\n${params.prompt}`
      : `${params.description}\n\n${params.prompt}`;
    const result = await agent.send(
      fullPrompt,
      params.signal !== undefined ? { signal: params.signal } : undefined,
    );
    return result.reply.trim().length > 0
      ? result.reply.trim()
      : "Sub-agent finished without a textual result.";
  } finally {
    try {
      await agent.close();
    } catch {
      // ignore
    }
    if (params.onEvent !== undefined) {
      try {
        await streamPromise;
      } catch {
        // ignore
      }
    }
    await posixTools.dispose();
  }
}

export const taskToolDefinition: ToolDefinition = {
  name: "task",
  description:
    "Delegate a self-contained sub-task to an autonomous sub-agent. The sub-agent has the full file, search, and shell toolset, runs without approval prompts, and returns a concise written result. Use it to parallelize exploration (\"map every caller of X\", \"summarize how module Y works\") or to hand off a well-scoped implementation so your own context stays focused. Fire several task calls in one turn to run sub-agents in parallel. The sub-agent cannot ask you questions and shares your working tree, so give it everything it needs in the prompt. Use the context field for durable background information (codebase structure, conventions, constraints) and the prompt field for the actionable goal.",
  inputSchema: {
    type: "object",
    properties: {
      description: {
        type: "string",
        description: "A short label for the sub-task (a few words), shown in the activity log.",
      },
      context: {
        type: "string",
        description:
          "Optional: durable background information such as codebase structure, conventions, or constraints that provide context for the task.",
      },
      prompt: {
        type: "string",
        description:
          "The actionable goal and specific instructions for the sub-agent: what it needs to accomplish and what to report back.",
      },
      agent: {
        type: "string",
        description:
          "Optional named agent profile from .agents/agents/ to use for this task. Profiles specify tier, capability restrictions, and role. Omit to use the default provider.",
      },
    },
    required: ["description", "prompt"],
  },
};

export type TaskToolDeps = {
  cwd: string;
  getWorkdirBase: () => string;
  // A getter so a live /agent provider/model/effort switch reaches subagents
  // spawned after the change, not just the value captured at startup. A plain
  // value is also accepted for callers with no live switching (e.g. headless).
  provider: SubAgentProvider | (() => SubAgentProvider);
  maxTurns?: number;
  // Injectable for tests; defaults to the real runSubAgent.
  run?: (params: RunSubAgentParams) => Promise<string>;
  onEvent?: (event: import("@intx/inference").ReactorEmittedEvent) => void;
  settings?: Settings;
  profiles?: AgentProfile[];
};

export function createTaskTool(deps: TaskToolDeps): AgentTool {
  const run = deps.run ?? runSubAgent;
  return stringTool({
    definition: taskToolDefinition,
    handler: async (args: Record<string, unknown>, signal: AbortSignal): Promise<string> => {
      const description = typeof args.description === "string" ? args.description.trim() : "";
      const context = typeof args.context === "string" ? args.context.trim() : undefined;
      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
      const agentId = typeof args.agent === "string" ? args.agent.trim() : undefined;
      if (description.length === 0 || prompt.length === 0) {
        return "Error: task requires a non-empty description and prompt.";
      }

      let provider: SubAgentProvider =
        typeof deps.provider === "function" ? deps.provider() : deps.provider;
      let capabilities: CapabilityFilter | undefined;
      let systemPromptRole: string | undefined;

      if (agentId !== undefined && agentId.length > 0 && deps.profiles !== undefined) {
        const profile = deps.profiles.find((p) => p.id === agentId);
        if (profile !== undefined) {
          if (profile.capabilities !== undefined) {
            capabilities = profile.capabilities;
          }
          if (profile.systemPromptRole !== undefined) {
            systemPromptRole = profile.systemPromptRole;
          }
          if (profile.tier !== undefined && deps.settings !== undefined) {
            const assignment = resolveTier(profile.tier as ProviderTier, deps.settings);
            if (assignment !== null) {
              const providerSettings = deps.settings.providers[assignment.provider];
              if (providerSettings !== undefined) {
                provider = {
                  providerName: assignment.provider,
                  baseURL: providerSettings.baseURL,
                  apiKey: providerSettings.apiKey,
                  model: assignment.model,
                };
              }
            }
          }
        }
      }

      try {
        const params: RunSubAgentParams = {
          cwd: deps.cwd,
          workdirBase: deps.getWorkdirBase(),
          provider,
          description,
          ...(context !== undefined && context.length > 0 ? { context } : {}),
          prompt,
          signal,
          ...(deps.maxTurns !== undefined ? { maxTurns: deps.maxTurns } : {}),
          ...(deps.onEvent !== undefined ? { onEvent: deps.onEvent } : {}),
          ...(capabilities !== undefined ? { capabilities } : {}),
          ...(systemPromptRole !== undefined ? { systemPromptRole } : {}),
        };
        const result = await run(params);
        return `Sub-agent "${description}" reported:\n\n${result}`;
      } catch (err) {
        return `Error: sub-agent "${description}" failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}
