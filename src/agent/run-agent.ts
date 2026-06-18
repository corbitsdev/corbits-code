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
import { noopAuditStore, permissiveAuthorize } from "@intx/agent/testing";
import type { SendResult } from "@intx/agent";
import { createIsogitStore } from "@intx/storage-isogit";
import { type } from "arktype";
import { createPosixTools } from "@intx/tools-posix";
import { createLSPPlugin } from "@intx/tools-lsp";
import type { ReactorEmittedEvent } from "@intx/inference";
import { registerOpenAICompatibleAdapter } from "../provider/openai-compatible-adapter.js";
import { registerCodexResponsesAdapter } from "../provider/codex-responses-adapter.js";
import { registerGrokResponsesAdapter } from "../provider/grok-responses-adapter.js";
import { xaiProfileFromProviderName } from "../config/xai-providers.js";
import { getValidXaiToken } from "../auth/xai/session.js";
import { codexProfileFromProviderName } from "../config/codex-providers.js";
import { CODEX_HEADLESS_REFRESH_INTERVAL_MS } from "../auth/codex/constants.js";
import { getValidCodexToken } from "../auth/codex/session.js";

import { buildCodexSource, buildOpenAISource, buildXaiSource, type Config } from "../config/index.js";
import { createCodingDirector, advanceWorkflowDefinition, askOperatorDefinition, submitOutputDefinition } from "./director.js";
import { authzPlugin } from "../plugins/authz-plugin.js";
import { pathEscapePlugin } from "../plugins/path-escape-plugin.js";
import { reReadBlockPlugin } from "../plugins/re-read-block-plugin.js";
import { verifyPlugin } from "../plugins/verify-plugin.js";
import { permissionPlugin } from "../plugins/permission-plugin.js";
import { secretGuardPlugin } from "../plugins/secret-guard-plugin.js";
import { ripgrepPlugin } from "../plugins/ripgrep-plugin.js";
import { webToolsPlugin } from "../web/plugin.js";
import { collectWebPlugins, resolveWebProviderFromPlugins, webBrand } from "../web/plugin-provider.js";
import { setActiveWebProviderBrand } from "../tui/tool-formatter.js";
import { discoverRepoPlugins, discoverUserPlugins, loadPluginsFromPaths } from "../plugins/loader.js";
import { collectToolPlugins, resolveToolPlugins } from "../plugins/tool-plugins.js";
import { connectMCPServers } from "../mcp/client.js";
import { createMCPPlugin } from "../mcp/plugin.js";
import { createPermissionGate } from "../permission/gate.js";
import { loadApprovals } from "../permission/store.js";
import { buildSystemPrompt } from "./prompts.js";
import { gatherEnvironment } from "./environment.js";
import { createTaskTool } from "../subagent/index.js";
import { loadAgentProfiles } from "./profiles.js";
import { saveState, loadState, saveDirectorState, loadDirectorState, type DirectorPersistedState } from "../session/state.js";
import { runCritique } from "./critic.js";
import { loadPricing, startPricingRefresh } from "../cost/pricing-fetcher.js";
import { setModelReasoningCapabilities } from "../provider/reasoning-effort.js";
import { setModelContextWindows } from "../provider/context-window.js";
import { createRenderer } from "./renderer.js";
import { consumeStream } from "../session/stream-consumer.js";
import {
  createLifecycleHookManager,
  createRunSummary,
  createTurnContextCollector,
  discoverLifecycleHooks,
  hookDirectories,
} from "../session/hooks.js";
import { initSessionDir, sessionContextDir, sessionDir } from "../session/index.js";

/* eslint-disable no-console */

export async function loadAgentContextExtensions(cwd: string): Promise<string[]> {
  const extensions: string[] = [];
  const agentsMdPath = join(cwd, "AGENTS.md");
  try {
    const content = await Bun.file(agentsMdPath).text();
    if (content.trim().length > 0) {
      const MAX_AGENTS_MD_BYTES = 32_000;
      if (content.length > MAX_AGENTS_MD_BYTES) {
        process.stderr.write(
          `[interchange] Warning: AGENTS.md exceeds ${MAX_AGENTS_MD_BYTES} bytes and will be truncated.\n`
        );
      }
      // AGENTS.md is reference context, not a script. Its onboarding /
      // session-initialization steps (e.g. "load the style skill") are written
      // for external agents and reference files that may not exist here; running
      // them on startup just produces file-not-found errors. Frame it as
      // background and tell the model not to execute those steps.
      extensions.push(
        `## Project guidance (AGENTS.md, reference)\n\n` +
          `The following is the repository's AGENTS.md, provided as background about the project. ` +
          `Do not execute its agent-onboarding or session-initialization steps (loading skills, reading skill files) — ` +
          `they target other tools and those files may not exist in this repo. Use it as reference when it helps the task.\n\n` +
          content.slice(0, MAX_AGENTS_MD_BYTES),
      );
    }
  } catch (err: unknown) {
    // File not found is expected and silent. Other errors are logged.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      process.stderr.write(`[interchange] Warning: could not read AGENTS.md: ${String(err)}\n`);
    }
  }
  return extensions;
}

function readLineFromStdin(signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const cleanup = (): void => {
      process.stdin.off("data", onData);
      process.stdin.pause();
    };
    const onAbort = (): void => {
      cleanup();
      reject(new Error("aborted"));
    };
    const onData = (chunk: Buffer): void => {
      const str = chunk.toString();
      const newline = str.indexOf("\n");
      if (newline !== -1) {
        chunks.push(Buffer.from(str.slice(0, newline)));
        signal.removeEventListener("abort", onAbort);
        cleanup();
        resolve(Buffer.concat(chunks).toString());
      } else {
        chunks.push(chunk);
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

export async function runAgent(
  config: Config,
  initialStartedAt?: number,
  initialDirectorState?: DirectorPersistedState,
  onEvent?: (event: ReactorEmittedEvent) => void,
): Promise<number> {
  registerOpenAICompatibleAdapter();
  registerCodexResponsesAdapter();
  registerGrokResponsesAdapter();
  await initSessionDir(config.cwd, config.sessionId);
  const state = await loadState(config.cwd, config.sessionId);
  if (state !== null && state.status === "running" && !config.force) {
    console.error("A run is already in progress in this directory. Use --force to override.");
    return 1;
  }

  const startedAt = initialStartedAt ?? Date.now();
  const pricingCache = await loadPricing();
  setModelReasoningCapabilities(pricingCache?.reasoning ?? {});
  setModelContextWindows(pricingCache?.contextWindows);
  const pricingRefresh = startPricingRefresh();
  const hookManager = createLifecycleHookManager({
    hooks: await discoverLifecycleHooks(hookDirectories(config.cwd)),
    logError: (message) => console.error(message),
  });

  // directorHolder is populated after director is created; the re-read plugin
  // only executes during tool calls, which happen after wiring is complete.
  const directorHolder: { instance?: ReturnType<typeof createCodingDirector> } = {};

  const approvals = await loadApprovals(config.cwd, config.sessionId);
  const permissionGate = createPermissionGate({
    approvals,
    cwd: config.cwd,
    interactive: false,
    skipPermissions: config.dangerouslySkipPermissions,
    auto: config.auto,
  });

  const mcpClients = await connectMCPServers(
    config.mcpServers ?? [],
    (msg) => process.stderr.write(`${msg}\n`),
    { stderr: "inherit" },
  );
  const { plugin: mcpPlugin } = createMCPPlugin(mcpClients);

  const pluginModules = [
    ...(await discoverRepoPlugins()),
    ...(await discoverUserPlugins(config.cwd)),
    ...(await loadPluginsFromPaths(config.settings?.pluginPaths ?? [], config.cwd)),
  ];
  const activeWeb = await resolveWebProviderFromPlugins({
    candidates: collectWebPlugins(pluginModules),
    pluginConfig: config.settings?.plugins ?? {},
    webOverride: config.settings?.web,
  });
  if (activeWeb !== undefined) setActiveWebProviderBrand(webBrand(activeWeb.name));
  const webProvider = activeWeb?.provider;
  const extraToolPlugins = await resolveToolPlugins({
    candidates: collectToolPlugins(pluginModules),
    pluginConfig: config.settings?.plugins ?? {},
  });

  const posixTools = createPosixTools({
    cwd: config.cwd,
    plugins: [
      pathEscapePlugin(config.cwd),
      secretGuardPlugin(),
      authzPlugin(),
      permissionPlugin(permissionGate),
      ripgrepPlugin(config.cwd),
      verifyPlugin(),
      reReadBlockPlugin(() => directorHolder.instance),
      webToolsPlugin(webProvider !== undefined ? { provider: webProvider } : {}),
      createLSPPlugin({ cwd: config.cwd, minSeverity: 1 }),
      mcpPlugin,
      // User tool plugins last so they cannot shadow core middleware.
      ...extraToolPlugins,
    ],
  });

  const posixToolList = fromToolRunner(posixTools);
  const workdir = sessionContextDir(config.cwd, config.sessionId);

  const agentProfiles = await loadAgentProfiles(join(config.cwd, ".agents", "agents"));

  const agentTools = [
    ...posixToolList,
    createTaskTool({
      cwd: config.cwd,
      getWorkdirBase: () => sessionDir(config.cwd, config.sessionId),
      provider: {
        providerName: config.providerName,
        baseURL: config.baseURL,
        apiKey: config.apiKey,
        model: config.model,
        ...(config.reasoningEffort !== undefined ? { reasoningEffort: config.reasoningEffort } : {}),
      },
      ...(config.settings !== undefined ? { settings: config.settings } : {}),
      ...(agentProfiles.length > 0 ? { profiles: agentProfiles } : {}),
    }),
    stringTool({
      definition: askOperatorDefinition,
      handler: async (args: Record<string, unknown>, signal: AbortSignal): Promise<string> => {
        const parsed = type({ "question?": "string", "options?": "unknown[]" })(args);
        const question = !(parsed instanceof type.errors) && parsed.question !== undefined ? parsed.question : "";
        const options = !(parsed instanceof type.errors) && parsed.options !== undefined ? parsed.options.map(String) : [];
        if (options.length === 0) {
          return "Error: ask_operator requires at least one option.";
        }
        process.stderr.write(`\n[operator question] ${question}\n`);
        options.forEach((opt, i) => {
          process.stderr.write(`  ${i}: ${opt}\n`);
        });
        process.stderr.write("Enter option number: ");
        const selected = await readLineFromStdin(signal);
        const index = parseInt(selected.trim(), 10);
        if (isNaN(index) || index < 0 || index >= options.length) {
          return `Error: invalid selection "${selected.trim()}". Valid range: 0-${options.length - 1}.`;
        }
        return options[index] as string;
      },
    }),
    stringTool({
      definition: submitOutputDefinition,
      handler: async (args: Record<string, unknown>, _signal: AbortSignal): Promise<string> => {
        // Step-tagged submit_output ({ step: "x" }) is a workflow step-advancement
        // signal, not a terminal submission. Do not require a plan for these.
        if (!(type({ step: "string" })(args) instanceof type.errors)) {
          return "Step advanced.";
        }
        return "Submission accepted. The task is now complete.";
      },
    }),
    stringTool({
      definition: advanceWorkflowDefinition,
      handler: async (_args: Record<string, unknown>, _signal: AbortSignal): Promise<string> => {
        // The coding director's tool.done handler dispatches to the workflow
        // coordinator when advance_workflow completes. This handler is a
        // pass-through — the coordinator read the args during tracking.
        return "Advanced.";
      },
    }),
  ];

  const codingDirectorDef = defineDirector({
    id: "intercode/coding",
    configSchema: type({}),
    factory: (_config, _env, agentCtx) => {
      const d = createCodingDirector(
        agentCtx.systemPrompt,
        [...agentCtx.toolDefinitions],
        initialDirectorState,
        config.maxTurns,
        config.inactivityTimeoutMs,
        config.totalTimeoutMs,
      );
      directorHolder.instance = d;
      return d;
    },
  });

  const toolsFactory = defineTool({
    id: "intercode/tools",
    factory: () => createToolRunner(agentTools),
  });

  const agentExtensions = await loadAgentContextExtensions(config.cwd);
  const extensions = [...agentExtensions, ...(config.systemPromptExtensions ?? [])];
  const environment = await gatherEnvironment(config.cwd);
  const systemPrompt = buildSystemPrompt(undefined, extensions.length > 0 ? extensions : undefined, environment);

  const def = defineAgent({
    id: "intercode/agent",
    systemPrompt,
    tools: [toolsFactory],
    capabilities: [],
    director: codingDirectorDef.build({}),
    inference: {
      sources: [{ provider: config.providerName, model: config.model }],
    },
  });

  const storage = await createIsogitStore(workdir);

  const codexProfile = codexProfileFromProviderName(config.providerName);
  // Refresh once up front; the seeded catalog token may already be stale. The
  // fresh account id rides along, avoiding a second profile read.
  const codexAccess = codexProfile !== undefined ? await getValidCodexToken(codexProfile) : undefined;
  const codexToken = codexAccess?.access ?? config.apiKey;
  const codexAccountId =
    codexAccess?.accountId ?? config.providers.find((p) => p.name === config.providerName)?.codexAccountId;
  const codexSource =
    codexProfile !== undefined
      ? buildCodexSource({
          id: config.providerName,
          apiKey: codexToken,
          model: config.model,
          sessionId: config.sessionId,
          ...(codexAccountId !== undefined ? { accountId: codexAccountId } : {}),
          ...(config.reasoningEffort !== undefined ? { reasoningEffort: config.reasoningEffort } : {}),
        })
      : undefined;

  const xaiProfile = xaiProfileFromProviderName(config.providerName);
  const xaiAccess = xaiProfile !== undefined ? await getValidXaiToken(xaiProfile) : undefined;
  const xaiSource =
    xaiProfile !== undefined
      ? buildXaiSource({
          id: config.providerName,
          apiKey: xaiAccess?.access ?? config.apiKey,
          model: config.model,
        })
      : undefined;
  const agent = await createAgent(def, {
    source:
      codexSource ??
      xaiSource ??
      buildOpenAISource({
        id: config.providerName,
        baseURL: config.baseURL,
        apiKey: config.apiKey,
        model: config.model,
        ...(config.reasoningEffort !== undefined ? { reasoningEffort: config.reasoningEffort } : {}),
      }),
    storage,
    workdir,
    audit: noopAuditStore(),
    authorize: permissiveAuthorize(),
    directors: createDirectorRegistry({ factories: [codingDirectorDef.factory], defaultId: "intercode/coding" }),
  });

  // directorHolder is populated synchronously by the factory during createAgent.
  if (directorHolder.instance === undefined) {
    throw new Error("createAgent completed without populating the director; codingDirectorDef.factory was not invoked");
  }
  const director = directorHolder.instance;

  await saveState(config.cwd, config.sessionId, {
    status: "running",
    turnsUsed: director.getTurnsUsed(),
    task: config.task,
    startedAt,
  });
  await saveDirectorState(config.cwd, config.sessionId, director.getState());

  const renderer = createRenderer(startedAt, config.model, pricingCache);
  const turnCollector = createTurnContextCollector((ctx) => {
    hookManager.dispatchPostTurn(ctx);
  });
  // A headless run can outlive a Codex access token (≈1h). With no per-send
  // refresh hook, reseed the source from a fresh token on an interval so a
  // long run does not start sending a dead credential mid-flight.
  let codexAccessToken = codexToken;
  const codexRefresh =
    codexProfile !== undefined && codexSource !== undefined
      ? setInterval(() => {
          void getValidCodexToken(codexProfile)
            .then(({ access }) => {
              if (access !== codexAccessToken) {
                codexAccessToken = access;
                agent.setSource({ ...codexSource, apiKey: access });
              }
            })
            .catch(() => {});
        }, CODEX_HEADLESS_REFRESH_INTERVAL_MS)
      : undefined;

  const sendPromise = agent.send(config.task);

  const streamPromise = consumeStream(agent.stream(), (event) => {
    turnCollector.observe(event);
    if (onEvent !== undefined) {
      onEvent(event);
    } else {
      renderer.render(event);
    }
  });

  async function cleanup(): Promise<void> {
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
    clearInterval(pricingRefresh);
    if (codexRefresh !== undefined) clearInterval(codexRefresh);
    await posixTools.dispose();
  }

  let result: SendResult;
  try {
    result = await sendPromise;
  } catch (err) {
    const finishedAt = Date.now();
    const error = err instanceof Error ? err.message : String(err);
    await hookManager.dispatchPostRun(createRunSummary({
      task: config.task,
      status: "failed",
      startedAt,
      finishedAt,
      turnsUsed: director.getTurnsUsed(),
      tokenUsage: turnCollector.getTokenUsage(),
      turns: turnCollector.getTurns(),
      toolCallCount: turnCollector.getToolCallCount(),
      error,
    }));
    await saveState(config.cwd, config.sessionId, {
      status: "failed",
      turnsUsed: director.getTurnsUsed(),
      task: config.task,
      startedAt,
      finishedAt,
      error,
    });
    await saveDirectorState(config.cwd, config.sessionId, director.getState());
    await cleanup();
    throw err;
  }

  const critique = await runCritique(config.cwd);
  if (!critique.passed) {
    const finishedAt = Date.now();
    const error = critique.errors.join("; ");
    await hookManager.dispatchPostRun(createRunSummary({
      task: config.task,
      status: "failed",
      startedAt,
      finishedAt,
      turnsUsed: director.getTurnsUsed(),
      tokenUsage: turnCollector.getTokenUsage(),
      turns: turnCollector.getTurns(),
      toolCallCount: turnCollector.getToolCallCount(),
      error,
    }));
    await saveState(config.cwd, config.sessionId, {
      status: "failed",
      turnsUsed: director.getTurnsUsed(),
      task: config.task,
      startedAt,
      finishedAt,
      error,
    });
    await saveDirectorState(config.cwd, config.sessionId, director.getState());
    console.error("Critique failed:");
    for (const e of critique.errors) {
      console.error(`  - ${e}`);
    }
    await cleanup();
    return 1;
  }

  const finishedAt = Date.now();
  await hookManager.dispatchPostRun(createRunSummary({
    task: config.task,
    status: "done",
    startedAt,
    finishedAt,
    turnsUsed: director.getTurnsUsed(),
    tokenUsage: turnCollector.getTokenUsage(),
    turns: turnCollector.getTurns(),
    toolCallCount: turnCollector.getToolCallCount(),
  }));
  await saveState(config.cwd, config.sessionId, {
    status: "done",
    turnsUsed: director.getTurnsUsed(),
    task: config.task,
    startedAt,
    finishedAt,
  });
  await saveDirectorState(config.cwd, config.sessionId, director.getState());

  console.log(result.reply);

  await cleanup();
  return 0;
}

export function traceEvent(event: ReactorEmittedEvent): void {
  switch (event.type) {
    case "inference.tool_call.start": {
      process.stderr.write(`[tool-start] ${event.data.name}\n`);
      break;
    }
    case "inference.tool_call.end": {
      process.stderr.write(
        `[tool] ${event.data.name} (${JSON.stringify(event.data.arguments)})\n`,
      );
      break;
    }
    case "tool.start": {
      process.stderr.write(`[exec-start] ${event.data.call.name}\n`);
      break;
    }
    case "tool.done": {
      const prefix = event.data.result.isError ? "[tool-error]" : "[tool-done]";
      process.stderr.write(`${prefix} ${event.data.result.callId}\n`);
      break;
    }
    case "inference.error": {
      process.stderr.write(
        `[inference-error] ${event.data.error.category}: ${event.data.error.message}\n`,
      );
      break;
    }
    case "reactor.error": {
      process.stderr.write(
        `[reactor-error] fatal=${event.data.fatal}: ${event.data.error}\n`,
      );
      break;
    }
    case "connector.reply": {
      process.stderr.write(`[reply] ${event.data.content}\n`);
      break;
    }
    case "reactor.done": {
      process.stderr.write(`[done]\n`);
      break;
    }
    default:
      break;
  }
}
/* eslint-enable no-console */
