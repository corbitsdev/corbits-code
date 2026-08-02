import { useMemo, useRef } from "react";
import { buildCostSummary, type CostSummary } from "../../cost/cost-summary.js";
import { getActivePricingCache } from "../../cost/cost-visibility.js";
import { goalKickoffUserMessage, type GoalResumeOpts, type GoalSetOpts, type GoalSnapshot } from "../../agent/goal.js";
import type { ProviderCatalogEntry } from "../../config/index.js";
import type { AgentStreamView } from "../use-stream.js";
import type { CommandContext } from "../commands/registry.js";
import type { OutboundUserMessage } from "../message-types.js";

export type UseCommandContextArgs = {
  provider: string;
  providerCatalog: ProviderCatalogEntry[];
  modelRef: { current: string };
  state: AgentStreamView;
  mcpServers: Array<{ name: string; tools: string[] }>;
  startNewSessionRef: { current: () => void };
  onStartWorkflow: ((name: string) => string) | undefined;
  onRenameSession: ((name: string) => string | undefined) | undefined;
  goalApi:
    | {
        get: () => GoalSnapshot | null;
        set: (condition: string, opts?: GoalSetOpts) => GoalSnapshot;
        pause: () => GoalSnapshot | null;
        resume: (opts?: GoalResumeOpts) => GoalSnapshot | null;
        clear: () => void;
      }
    | undefined;
  sendMessageRef: { current: (message: OutboundUserMessage) => void };
};

export type CommandContextController = {
  getCostSummary: () => CostSummary;
  commandContext: CommandContext;
};

export function useCommandContext({
  provider,
  providerCatalog,
  modelRef,
  state,
  mcpServers,
  startNewSessionRef,
  onStartWorkflow,
  onRenameSession,
  goalApi,
  sendMessageRef,
}: UseCommandContextArgs): CommandContextController {
  const getCostSummary = () => {
    const activeProvider = providerCatalog.find((p) => p.name === provider);
    return buildCostSummary({
      modelId: modelRef.current,
      baseURL: activeProvider?.baseURL,
      providerFree: activeProvider?.free,
      pricingCache: getActivePricingCache(),
      totalCost: state.totalCost,
      formattedCost: state.formattedCost,
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      cacheReadTokens: state.cacheReadTokens,
      contextTokens: state.contextTokens,
    });
  };
  // commandContext below is memoized, so it would otherwise capture a stale
  // getCostSummary closure (provider/state from an old render). Routing the
  // call through a ref updated every render keeps the memoized context reading
  // live values, matching the signalClear/startNewSessionRef pattern.
  const getCostSummaryRef = useRef(getCostSummary);
  getCostSummaryRef.current = getCostSummary;

  const commandContext = useMemo(() => ({
    signalClear: () => startNewSessionRef.current(),
    getMCPServers: () => mcpServers,
    getCostSummary: () => getCostSummaryRef.current(),
    ...(onStartWorkflow !== undefined ? { startWorkflow: onStartWorkflow } : {}),
    ...(onRenameSession !== undefined ? { renameSession: onRenameSession } : {}),
    ...(goalApi !== undefined
      ? {
          goal: {
            get: goalApi.get,
            set: goalApi.set,
            pause: goalApi.pause,
            resume: goalApi.resume,
            clear: goalApi.clear,
            kickoff: (condition: string, phase: "set" | "resume" = "set") => {
              // Start a turn immediately so the agent works without a second prompt.
              // Set path forces clarify-first for vague goals; resume continues.
              sendMessageRef.current({
                text: goalKickoffUserMessage(condition, phase),
                attachments: [],
              });
            },
          },
        }
      : {}),
  }), [mcpServers, onStartWorkflow, onRenameSession, goalApi]);

  return { getCostSummary, commandContext };
}
