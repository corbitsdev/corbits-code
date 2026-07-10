import { mkdir } from "node:fs/promises";
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
import { createOptimizedContextStore } from "../session/optimized-context-store.js";
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

import { buildBifrostSource, buildOpenAISource, type ProviderCatalogEntry } from "../config/index.js";
import { buildInferenceSourceForRef, buildSubagentSources } from "../config/inference-sources.js";
import { createInferenceDependencies } from "../provider/inference-dependencies.js";
import type { ReasoningEffort } from "../provider/reasoning-effort.js";
import { pathEscapePlugin } from "../plugins/path-escape-plugin.js";
import { secretGuardPlugin } from "../plugins/secret-guard-plugin.js";
import { authzPlugin } from "../plugins/authz-plugin.js";
import {
  advertiseShellGuardTimeout,
  shellGuardPlugin,
} from "../plugins/shell-guard-plugin.js";
import { ripgrepPlugin } from "../plugins/ripgrep-plugin.js";
import { verifyPlugin } from "../plugins/verify-plugin.js";
import { toolOutputUriPlugin } from "../plugins/tool-output-uri-plugin.js";
import { lspHintPlugin } from "../plugins/lsp-hint-plugin.js";
import { webToolsPlugin } from "../web/plugin.js";
import { buildSubAgentSystemPrompt } from "../agent/prompts.js";
import { createCompactionGovernor, type CompactionGovernor } from "../agent/compaction.js";
import { createPruningCompactor } from "../session/compactor.js";
import { createModelSummarizer } from "../session/summarizer.js";
import { gatherEnvironment } from "../agent/environment.js";
import { generateSessionId } from "../session/index.js";
import { consumeStream } from "../session/stream-consumer.js";
import { withSubAgentSlot } from "./concurrency.js";
import type { CapabilityFilter, AgentProfile } from "../agent/profiles.js";
import type { Settings, ProviderTier } from "../config/settings.js";
import { resolveTier, resolveInferenceWithPolicy } from "../config/settings.js";
import { validateEffort } from "../provider/reasoning-effort.js";
import { isCodexProviderName } from "../config/codex-providers.js";
import { createSearchAgentsTool } from "../agent/agent-search.js";
import type { ReactorEmittedEvent } from "@intx/inference";

// A sub-agent is a worker, not a chat partner: it runs until it stops calling
// tools, at which point its final assistant text is the result handed back to
// the dispatcher. It has no submit_output and never blocks on the
// operator — autonomy is the whole point of delegation.

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
  private readonly compaction: CompactionGovernor;

  constructor(
    systemPrompt: string,
    toolDefinitions: ToolDefinition[],
    requestContinuation?: () => void,
  ) {
    super(systemPrompt, toolDefinitions, {});
    this.compaction = createCompactionGovernor(requestContinuation);
  }

  override async decide(
    event: ReactorInboundEvent,
    state: ReactorState,
    capabilities: ReactorCapabilities,
  ): Promise<ReactorAction | ReactorAction[]> {
    if (this.compaction.resumeAfterCompact(event)) {
      return capabilities.infer();
    }
    const recovery = this.compaction.interceptOverflow(event, capabilities);
    if (recovery !== null) return recovery;

    if (event.type === "inference.done") {
      this.compaction.noteInferenceDone(event, state.turns.length);
      const hasToolCalls = event.turn.content.some((b) => b.type === "tool_call");
      if (!hasToolCalls) {
        return [
          capabilities.checkpoint("subagent-complete"),
          capabilities.reply(lastText(event.turn.content)),
        ];
      }
    }
    const base = await super.decide(event, state, capabilities);
    const actions = Array.isArray(base) ? base : [base];
    return this.compaction.interceptActions(event, actions, capabilities) ?? base;
  }
}

export type SubAgentProvider = {
  providerName: string;
  baseURL: string;
  apiKey?: string;
  keyless?: boolean;
  model: string;
  // Subagents inherit the parent's reasoning effort so a /agent selection
  // applies to delegated work, not just the top-level loop.
  reasoningEffort?: ReasoningEffort;
  // Mirrors ProviderCatalogEntry.bifrostVirtualKey. Without it the generic
  // (no-tier) dispatch path builds a plain openai-compatible source and the
  // gateway never receives the x-bf-vk header.
  bifrostVirtualKey?: boolean;
};

// The source used when no profile tier resolves. Exported for tests: the
// parent's provider may need a non-default adapter (Bifrost virtual keys,
// Codex or xAI OAuth profiles speak the Responses API and reject plain Chat
// Completions requests with HTTP 426), so the catalog entry's markers pick
// the adapter exactly as the tiered path does.
export function buildSubAgentPrimarySource(
  provider: SubAgentProvider,
  catalog?: readonly ProviderCatalogEntry[],
  settings?: Settings,
) {
  if (catalog !== undefined) {
    const source = buildInferenceSourceForRef(
      { provider: provider.providerName, model: provider.model },
      {
        sessionId: generateSessionId(),
        catalog,
        ...(provider.reasoningEffort !== undefined
          ? { reasoningEffort: provider.reasoningEffort }
          : {}),
      },
      settings,
    );
    if (source !== null) return { sources: [source], defaultSource: source.id };
  }
  const build = provider.bifrostVirtualKey === true ? buildBifrostSource : buildOpenAISource;
  const primarySource = build({
    id: provider.providerName,
    baseURL: provider.baseURL,
    ...(provider.apiKey !== undefined ? { apiKey: provider.apiKey } : {}),
    model: provider.model,
    ...(provider.reasoningEffort !== undefined
      ? { reasoningEffort: provider.reasoningEffort }
      : {}),
  });
  return { sources: [primarySource], defaultSource: primarySource.id };
}

// Dependencies an orchestrator sub-agent needs to spawn further workers via
// `task`. Nested dispatch always sets allowOrchestrator: false so the
// recursion bottoms out at one hop of orchestration.
export type NestedDispatchDeps = {
  getWorkdirBase: () => string;
  provider: SubAgentProvider | (() => SubAgentProvider);
  onEvent?: (event: ReactorEmittedEvent) => void;
  // Fired on each tool_call.end so the parent can surface live activity without
  // replaying the full sub-agent event stream into the chat transcript.
  onProgress?: (info: { description: string; toolName: string }) => void;
  settings?: Settings | (() => Settings | undefined);
  catalog?: readonly ProviderCatalogEntry[] | (() => readonly ProviderCatalogEntry[]);
  profiles?: AgentProfile[] | (() => AgentProfile[]);
};

export type RunSubAgentParams = {
  cwd: string;
  workdirBase: string;
  provider: SubAgentProvider;
  tier?: ProviderTier;
  settings?: Settings;
  catalog?: readonly ProviderCatalogEntry[];
  description: string;
  context?: string;
  prompt: string;
  signal?: AbortSignal;
  onEvent?: (event: ReactorEmittedEvent) => void;
  onProgress?: (info: { description: string; toolName: string }) => void;
  capabilities?: CapabilityFilter;
  systemPromptRole?: string;
  // When true, the assembled system prompt grants this sub-agent permission
  // to call `task` to spawn further agents (orchestrator exception to the
  // no-recursion rule). Set from AgentProfile.orchestrator at dispatch time.
  // Requires nestedDispatch so the task tool can actually be installed —
  // advertising permission without the tool is a hard break.
  orchestrator?: boolean;
  // Present only when orchestrator is true. Installs task + search_agents so
  // the orchestrator can actually dispatch workers.
  nestedDispatch?: NestedDispatchDeps;
};

function applyCapabilityFilter(tools: AgentTool[], capabilities: CapabilityFilter): AgentTool[] {
  const nameSet = new Set(capabilities.tools);
  if (capabilities.mode === "exclude") {
    return tools.filter((t) => !nameSet.has(t.definition.name));
  }
  return tools.filter((t) => nameSet.has(t.definition.name));
}

// Extract the tool name from a sub-agent stream event. tool.start carries the
// call name at execution time; counting starts only (not ends) keeps the
// activity summary at one entry per invocation.
export function subAgentToolName(event: ReactorEmittedEvent): string | null {
  if (event.type !== "tool.start") return null;
  const call = (event as { data?: { call?: { name?: unknown } } }).data?.call;
  if (typeof call?.name === "string" && call.name.length > 0) return call.name;
  return null;
}

// Append a short activity footer so the parent model (and the operator reading
// the tool result) can see what the sub-agent actually did. Without this the
// only signal is the free-form reply, which models often omit tool details from.
export function appendActivitySummary(reply: string, toolNames: readonly string[]): string {
  if (toolNames.length === 0) return reply;
  const counts = new Map<string, number>();
  for (const name of toolNames) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([name, n]) => (n > 1 ? `${name}×${n}` : name));
  return `${reply}\n\n[tools: ${parts.join(", ")}]`;
}

// Spin up an isolated, autonomous agent loop against the same working tree,
// hand it one task, and return its final report. The sub-agent shares the
// dispatcher's cwd so its edits land in the real repo, but gets its own posix
// tool instances and its own git-backed context store so the two loops never
// trample each other's state.
export async function runSubAgent(params: RunSubAgentParams): Promise<string> {
  return withSubAgentSlot(() => runSubAgentInner(params));
}

async function runSubAgentInner(params: RunSubAgentParams): Promise<string> {
  const posixTools = createPosixTools({
    cwd: params.cwd,
    plugins: [
      pathEscapePlugin(params.cwd),
      toolOutputUriPlugin(),
      secretGuardPlugin(),
      authzPlugin(),
      shellGuardPlugin(params.cwd),
      ripgrepPlugin(params.cwd),
      verifyPlugin(),
      webToolsPlugin(),
      lspHintPlugin(),
      createLSPPlugin({ cwd: params.cwd, minSeverity: 1 }),
    ],
  });
  // Align advertised run_shell timeout with shell-guard's 10s default.
  let tools = fromToolRunner(posixTools).map((tool) => ({
    ...tool,
    definition: advertiseShellGuardTimeout(tool.definition),
  }));

  if (params.capabilities !== undefined) {
    tools = applyCapabilityFilter(tools, params.capabilities);
  }

  // Orchestrators need task + search_agents installed, not just mentioned in
  // the prompt. Nested dispatch always forbids further orchestration so the
  // tree bottoms out after one hop.
  if (params.orchestrator === true) {
    if (params.nestedDispatch === undefined) {
      throw new Error(
        "runSubAgent: orchestrator=true requires nestedDispatch so the task tool can be installed",
      );
    }
    const nd = params.nestedDispatch;
    tools = [
      ...tools,
      createTaskTool({
        cwd: params.cwd,
        getWorkdirBase: nd.getWorkdirBase,
        provider: nd.provider,
        allowOrchestrator: false,
        ...(nd.onEvent !== undefined ? { onEvent: nd.onEvent } : {}),
        ...(nd.onProgress !== undefined ? { onProgress: nd.onProgress } : {}),
        ...(nd.settings !== undefined ? { settings: nd.settings } : {}),
        ...(nd.catalog !== undefined ? { catalog: nd.catalog } : {}),
        ...(nd.profiles !== undefined ? { profiles: nd.profiles } : {}),
      }),
      ...(nd.profiles !== undefined
        ? [
            createSearchAgentsTool(() => {
              const profiles = nd.profiles;
              return typeof profiles === "function" ? profiles() : (profiles ?? []);
            }),
          ]
        : []),
    ];
  }

  const environment = await gatherEnvironment(params.cwd);
  const extensions =
    params.systemPromptRole !== undefined ? [params.systemPromptRole] : undefined;
  const toolNames = tools.map((t) => t.definition.name);
  const systemPrompt = buildSubAgentSystemPrompt(extensions, environment, undefined, {
    orchestrator: params.orchestrator === true,
    toolNames,
  });

  let agentHandle: Awaited<ReturnType<typeof createAgent>> | null = null;
  const requestContinuation = (): void => {
    try {
      agentHandle?.deliver({
        ref: { uid: 0, mailbox: "system" },
        headers: {
          from: "user@local",
          to: ["agent@local"],
          date: new Date().toISOString(),
          messageId: `compact-continue-${Date.now()}@local`,
        },
        flags: [],
        content: "",
        signatureStatus: "missing",
      });
    } catch {
      // Agent may be closing; a dropped continuation is harmless.
    }
  };

  const directorDef = defineDirector({
    id: "intercode/subagent",
    configSchema: type({}),
    factory: (_config, _env, agentCtx) =>
      new SubAgentDirector(
        agentCtx.systemPrompt,
        [...agentCtx.toolDefinitions],
        requestContinuation,
      ),
  });

  const toolsFactory = defineTool({
    id: "intercode/subagent-tools",
    factory: () => createToolRunner(tools),
  });

  const workdir = join(params.workdirBase, "subagents", generateSessionId());
  await mkdir(workdir, { recursive: true });

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

  const storage = await createOptimizedContextStore(workdir);

  const head = { provider: params.provider.providerName, model: params.provider.model };
  const bundle =
    params.tier !== undefined && params.settings !== undefined && params.catalog !== undefined
      ? buildSubagentSources({
          settings: params.settings,
          catalog: params.catalog,
          tier: params.tier,
          head,
          ...(params.provider.reasoningEffort !== undefined
            ? { reasoningEffort: params.provider.reasoningEffort }
            : {}),
        })
      : buildSubAgentPrimarySource(params.provider, params.catalog, params.settings);
  const inferenceDeps = await createInferenceDependencies();
  const subagentSource =
    bundle.sources.find((s) => s.id === bundle.defaultSource) ?? bundle.sources[0];
  const agent = await createAgent(def, {
    sources: bundle.sources,
    defaultSource: bundle.defaultSource,
    storage,
    workdir,
    deps: inferenceDeps,
    audit: noopAuditStore(),
    authorize: permissiveAuthorize(),
    directors: createDirectorRegistry({
      factories: [directorDef.factory],
      defaultId: "intercode/subagent",
    }),
    compactors: {
      "pruning-compactor": createPruningCompactor({
        keepRecentTurns: 6,
        summaryMaxChars: 2500,
        stripResultContent: true,
        // A structured model summary keeps sub-agent context useful across a
        // compaction; the deterministic stub remains the fallback on failure.
        ...(subagentSource !== undefined
          ? { summarize: createModelSummarizer({ getSource: () => subagentSource, deps: inferenceDeps }) }
          : {}),
      }),
    },
  });
  agentHandle = agent;

  // Collect tool activity for the parent-facing report, and optionally forward
  // progress without dumping the full sub-agent event stream into the chat
  // transcript (which would interleave sub-agent text with the parent turn).
  const toolNamesUsed: string[] = [];
  const streamSink = (event: ReactorEmittedEvent): void => {
    const name = subAgentToolName(event);
    if (name !== null) {
      toolNamesUsed.push(name);
      params.onProgress?.({ description: params.description, toolName: name });
    }
    params.onEvent?.(event);
  };
  const streamPromise = consumeStream(agent.stream(), streamSink);

  try {
    const fullPrompt = params.context
      ? `${params.description}\n\n## Context\n${params.context}\n\n## Task\n${params.prompt}`
      : `${params.description}\n\n${params.prompt}`;
    const sendOpts = params.signal !== undefined ? { signal: params.signal } : undefined;
    const result = await agent.send(fullPrompt, sendOpts);
    const reply =
      result.reply.trim().length > 0
        ? result.reply.trim()
        : "Sub-agent finished without a textual result.";
    return appendActivitySummary(reply, toolNamesUsed);
  } finally {
    try {
      await agent.close();
    } catch {
      // ignore
    }
    try {
      await streamPromise;
    } catch {
      // ignore
    }
    try {
      await posixTools.dispose();
    } catch {
      // LSP shutdown can fail when several sub-agents exit together.
    }
  }
}

const TaskToolArgs = type({
  description: "string",
  prompt: "string",
  "context?": "string",
  "agent?": "string",
});

export const taskToolDefinition: ToolDefinition = {
  name: "task",
  description:
    "Delegate a self-contained sub-task to an autonomous sub-agent. The sub-agent has the full file, search, and shell toolset, runs without approval prompts, and returns a concise written result. Use it to parallelize exploration (\"map every caller of X\", \"summarize how module Y works\") or to hand off a well-scoped implementation so your own context stays focused. Fire several task calls in one turn to run sub-agents in parallel. When launching multiple agents with the same profile, assign each a distinct lens in the description and prompt (for review: correctness/regressions, architecture/maintainability, tests/security/performance, UI/UX where relevant) so they do not duplicate work. The sub-agent cannot ask you questions and shares your working tree, so give it everything it needs in the prompt. Use the context field for durable background information (codebase structure, conventions, constraints) and the prompt field for the actionable goal, expected lens, and what to report back.",
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
          "Optional agent profile id from search_agents (or .agents/agents/). Profiles specify tier, capability restrictions, and role. Omit for a generic sub-agent on the default provider.",
      },
    },
    required: ["description", "prompt"],
  },
};

function resolveDep<T>(value: T | (() => T)): T {
  return typeof value === "function" ? (value as () => T)() : value;
}

export type TaskToolDeps = {
  cwd: string;
  getWorkdirBase: () => string;
  // A getter so a live /agent provider/model/effort switch reaches subagents
  // spawned after the change, not just the value captured at startup. A plain
  // value is also accepted for callers with no live switching.
  provider: SubAgentProvider | (() => SubAgentProvider);
  // Injectable for tests; defaults to the real runSubAgent.
  run?: (params: RunSubAgentParams) => Promise<string>;
  onEvent?: (event: ReactorEmittedEvent) => void;
  onProgress?: (info: { description: string; toolName: string }) => void;
  settings?: Settings | (() => Settings | undefined);
  catalog?: readonly ProviderCatalogEntry[] | (() => readonly ProviderCatalogEntry[]);
  profiles?: AgentProfile[] | (() => AgentProfile[]);
  // When false, profile.orchestrator is ignored so nested workers cannot
  // themselves become orchestrators. Defaults to true for the primary session.
  allowOrchestrator?: boolean;
};

export function createTaskTool(deps: TaskToolDeps): AgentTool {
  const run = deps.run ?? runSubAgent;
  return stringTool({
    definition: taskToolDefinition,
    handler: async (args: Record<string, unknown>, signal: AbortSignal): Promise<string> => {
      const parsed = TaskToolArgs(args);
      if (parsed instanceof type.errors) {
        return "Error: task requires description (string) and prompt (string).";
      }
      const { description: rawDesc, context: rawCtx, prompt: rawPrompt, agent: agentId } = parsed;
      const description = rawDesc.trim();
      const context = rawCtx?.trim();
      const prompt = rawPrompt.trim();
      if (description.length === 0 || prompt.length === 0) {
        return "Error: task requires a non-empty description and prompt.";
      }

      let provider: SubAgentProvider =
        typeof deps.provider === "function" ? deps.provider() : deps.provider;
      let capabilities: CapabilityFilter | undefined;
      let systemPromptRole: string | undefined;
      let orchestrator = false;
      let tier: ProviderTier | undefined;
      const settings = deps.settings !== undefined ? resolveDep(deps.settings) : undefined;
      const catalog = deps.catalog !== undefined ? resolveDep(deps.catalog) : undefined;
      const profiles = deps.profiles !== undefined ? resolveDep(deps.profiles) : undefined;

      if (agentId !== undefined && agentId.length > 0) {
        // Fail closed: an explicit agent= that cannot be resolved is an error,
        // not a silent fall-through to a generic worker. Silent fall-through
        // made typos and stale ids look like successful generic dispatches.
        if (profiles === undefined) {
          return `Error: agent "${agentId}" requested but no agent profiles are loaded. Omit agent to use a generic sub-agent, or ensure profiles are available.`;
        }
        const profile = profiles.find((p) => p.id === agentId);
        if (profile === undefined) {
          const known = profiles.map((p) => p.id).sort();
          const hint =
            known.length > 0
              ? ` Known profiles: ${known.join(", ")}. Call search_agents to discover more.`
              : " No profiles are currently loaded. Call search_agents to discover available agents.";
          return `Error: unknown agent profile "${agentId}".${hint}`;
        }
        if (profile.capabilities !== undefined) {
          capabilities = profile.capabilities;
        }
        if (profile.systemPromptRole !== undefined) {
          systemPromptRole = profile.systemPromptRole;
        }
        // Nested workers (allowOrchestrator: false) cannot re-enter orchestration
        // even if their profile is marked orchestrator — recursion bottoms out.
        if (profile.orchestrator === true && deps.allowOrchestrator !== false) {
          orchestrator = true;
        }
        if (settings !== undefined) {
          // Per-agent pinned inference (provider/model/effort) wins over the
          // tier alias when both are declared. Resolution uses policy
          // (mode: pin / agentModelFallback: none) so a forbidden fallback
          // surfaces as a dispatch error rather than silently running on the
          // parent's provider.
          let resolved:
            | { provider: string; model: string; reasoningEffort?: import("../provider/reasoning-effort.js").ReasoningEffort }
            | null = null;
          if (profile.inference !== undefined) {
            const outcome = resolveInferenceWithPolicy(profile.inference, settings);
            if (outcome.kind === "unavailable") {
              return `Error: agent "${agentId}" unavailable: ${outcome.reason}. Set agentModelFallback: "active" (or change the spec mode to "prefer") to fall back to the active session.`;
            }
            if (outcome.kind === "resolved") resolved = outcome.value;
          }
          if (resolved === null && profile.tier !== undefined) {
            const assignment = resolveTier(profile.tier as ProviderTier, settings);
            if (assignment !== null) {
              resolved = assignment;
            }
          }
          if (resolved !== null) {
            // Validate model/effort compatibility before dispatch so the
            // agent fails fast with a clear message instead of sending a
            // request the provider will reject mid-task. Mirrors the main
            // session bootstrap in src/config/index.ts.
            if (resolved.reasoningEffort !== undefined) {
              const verdict = validateEffort(
                resolved.model,
                resolved.reasoningEffort,
                isCodexProviderName(resolved.provider),
              );
              if (!verdict.ok) {
                return `Error: agent "${agentId}" has incompatible inference: ${verdict.error}`;
              }
            }
            const providerSettings = settings.providers[resolved.provider];
            if (providerSettings !== undefined) {
              // An inference leg or tier assignment that doesn't carry its
              // own reasoningEffort still inherits the parent session's
              // effort — keeps "/agent" effort propagation uniform across
              // pinned-resolution and fall-through-to-active paths.
              const effort =
                resolved.reasoningEffort ?? provider.reasoningEffort;
              provider = {
                providerName: resolved.provider,
                baseURL: providerSettings.baseURL,
                ...(providerSettings.keyless === true ? { keyless: true } : {}),
                ...(providerSettings.bifrostVirtualKey === true
                  ? { bifrostVirtualKey: true }
                  : {}),
                ...(providerSettings.apiKey !== undefined
                  ? { apiKey: providerSettings.apiKey }
                  : {}),
                model: resolved.model,
                ...(effort !== undefined ? { reasoningEffort: effort } : {}),
              };
            }
          }
          if (profile.tier !== undefined) {
            tier = profile.tier as ProviderTier;
          }
        }
      }

      try {
        const nestedDispatch: NestedDispatchDeps | undefined = orchestrator
          ? {
              getWorkdirBase: deps.getWorkdirBase,
              provider: deps.provider,
              ...(deps.onEvent !== undefined ? { onEvent: deps.onEvent } : {}),
              ...(deps.onProgress !== undefined ? { onProgress: deps.onProgress } : {}),
              ...(deps.settings !== undefined ? { settings: deps.settings } : {}),
              ...(deps.catalog !== undefined ? { catalog: deps.catalog } : {}),
              ...(deps.profiles !== undefined ? { profiles: deps.profiles } : {}),
            }
          : undefined;
        const params: RunSubAgentParams = {
          cwd: deps.cwd,
          workdirBase: deps.getWorkdirBase(),
          provider,
          ...(tier !== undefined ? { tier } : {}),
          ...(settings !== undefined ? { settings } : {}),
          ...(catalog !== undefined ? { catalog } : {}),
          description,
          ...(context !== undefined && context.length > 0 ? { context } : {}),
          prompt,
          signal,
          ...(deps.onEvent !== undefined ? { onEvent: deps.onEvent } : {}),
          ...(deps.onProgress !== undefined ? { onProgress: deps.onProgress } : {}),
          ...(capabilities !== undefined ? { capabilities } : {}),
          ...(systemPromptRole !== undefined ? { systemPromptRole } : {}),
          ...(orchestrator
            ? { orchestrator: true, nestedDispatch: nestedDispatch! }
            : {}),
        };
        const result = await run(params);
        return `Sub-agent "${description}" reported:\n\n${result}`;
      } catch (err) {
        return `Error: sub-agent "${description}" failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}