/**
 * Command layer for the TUI runner: slash-command registry population, the
 * command context the handlers run against, and result surfacing.
 */

import { getLogger } from "@intx/log";
import type { CommandContext, CommandResult } from "../commands/registry.js";
import { getCommand, setHiddenCommands } from "../commands/registry.js";
import { registerBuiltInCommands } from "../commands/built-in.js";
import { registerCommandPlugins, registerWorkflowPlugins } from "../../plugins/register.js";
import type { PluginModule } from "../../plugins/loader.js";
import type { PluginConfig } from "../../config/settings.js";
import { persistSkipPermissionsDefault, type Settings } from "../../config/settings.js";
import { getTelemetry } from "../../telemetry/singleton.js";
import { captureSlashCommand } from "../../telemetry/product-events.js";
import {
  armFeedbackCapture,
  cancelFeedbackCapture,
  captureFeedback,
  feedbackResultMessage,
  getLastTurnTraceId,
} from "../../telemetry/feedback.js";
import { getActivePricingCache } from "../../cost/cost-visibility.js";
import { formatCost } from "../../cost/faremeter.js";
import {
  buildCostSummary,
  maskContextMeterWhenNoTurns,
  type CostSummary,
} from "../../cost/cost-summary.js";
import { contextTokensFromUsage } from "../../provider/context-window.js";
import { fleetDigest } from "../../subagent/index.js";
import { renameSession } from "../../session/index.js";
import { truncateSessionLabel } from "../../session/session-label.js";
import { surfaceSystemNotice, attachClipboardImage } from "../shell/prompt.js";
import type { InferenceErrorLike } from "../../inference-gateway-error.js";
import { terminalProviderFailureMessage } from "../../inference-error-message.js";
import type { InferenceAttemptIdentity } from "./state.js";
import { hostOf, type RunnerServices, type RunnerState } from "./state.js";
import { userInboundMessage } from "./submit.js";
import { LOG_NAMESPACE_ROOT } from "../../branding.js";

const tuiLogger = getLogger([LOG_NAMESPACE_ROOT, "tui"]);

export function surfaceTerminalProviderFailure(
  shell: Parameters<typeof surfaceSystemNotice>[0],
  providerId: string,
  error: InferenceErrorLike,
  displayLabel?: string,
): void {
  surfaceSystemNotice(shell, terminalProviderFailureMessage(providerId, error, displayLabel));
}

/**
 * Populate the slash-command registry for a session: built-ins first, then
 * enabled plugin commands and workflows, then the hidden-command filter.
 *
 * Exported so the production wiring is testable — built-in registration used to
 * ride on an import side effect and silently disappeared when its only importer
 * was deleted.
 */
export function setUpCommandRegistry(
  settings: Settings | undefined,
  plugins: PluginModule[],
  getPluginConfig: () => Record<string, PluginConfig> = () => settings?.plugins ?? {},
): void {
  registerBuiltInCommands();
  registerWorkflowPlugins(plugins, getPluginConfig());
  registerCommandPlugins(plugins, getPluginConfig);
  setHiddenCommands(settings?.hiddenCommands ?? []);
}

export interface CommandLayer {
  currentAttemptIdentity: () => InferenceAttemptIdentity;
  commandContext: CommandContext;
}

/**
 * Wire the dispatch path: the command context handlers run against, result
 * surfacing, and the attempt identity the submit path reports failures
 * against.
 */
export function createCommandLayer(state: RunnerState, services: RunnerServices): CommandLayer {
  const currentAttemptIdentity = (): InferenceAttemptIdentity => {
    const displayLabel = state.config.settings?.providers[state.config.providerName]?.name;
    return {
      providerId: state.config.providerName,
      ...(displayLabel !== undefined ? { displayLabel } : {}),
    };
  };
  state.currentAttemptIdentity = currentAttemptIdentity;

  const commandContext: CommandContext = {
    signalClear: () => state.newSession?.(),
    getSkipPermissions: () => services.permissionGate.getSkipPermissions(),
    setSkipPermissions: (value: boolean) => {
      services.permissionGate.setSkipPermissions(value);
      state.config.dangerouslySkipPermissions = value;
      void services.globalSettingsWriter.enqueue(async () => {
        try {
          const result = await persistSkipPermissionsDefault(
            state.config.globalSettingsPath,
            value,
          );
          if (result === "skipped") {
            state.systemNotice?.("Yolo flipped for this session, but the default did not stick.");
          }
        } catch {
          state.systemNotice?.("Yolo flipped for this session, but the default did not stick.");
        }
      });
    },
    getCostSummary: (): CostSummary => {
      const usage = services.runSink.getTokenUsage();
      const lastTurnUsage = services.runSink.getLastTurnUsage();
      const pricingCache = getActivePricingCache();
      const billed = services.sessionCost.snapshot();
      const totalCost = billed.meteredCost;
      // A provider that omits or zeroes usage would otherwise pin the meter at
      // 0% forever; fall back to the director's local estimate (turns plus
      // system-prompt/tool-schema overhead). The governor already decided
      // whether it's estimating when it computed this turn's arming — trust
      // that decision rather than re-deriving it from a second usage read.
      const contextEstimate = services.directorHolder.instance?.getContextEstimate();
      const isEstimate = contextEstimate !== undefined && contextEstimate.isEstimate;
      const summary = buildCostSummary({
        modelId: state.config.model,
        baseURL: state.config.baseURL,
        providerName: state.config.providerName,
        pricingCache,
        totalCost,
        formattedCost: formatCost(totalCost),
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead,
        contextTokens: isEstimate ? contextEstimate.tokens : contextTokensFromUsage(lastTurnUsage),
        contextIsEstimate: isEstimate,
        sessionBillingMix: billed.mix,
        sessionHiddenReason: billed.hiddenReason,
      });
      return maskContextMeterWhenNoTurns(summary, services.runSink.getTurnCount());
    },
    startWorkflow: (name) => services.workflowController.start(name),
    getFleetStatus: () => fleetDigest(services.subAgentSessions.list(), Date.now()),
    renameSession: (name) => {
      const trimmed = name.trim();
      if (trimmed.length === 0) return "Session name cannot be empty";
      state.runTaskTitle = trimmed;
      services.emitter.emit("session.title", truncateSessionLabel(state.runTaskTitle));
      void renameSession(state.config.cwd, state.sessionId, trimmed)
        .then(() => state.persistRunSnapshot?.("running"))
        .catch((err: unknown) => {
          tuiLogger.warn("rename session failed: {error}", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      return undefined;
    },
    submitFeedback: (text) => {
      // Inline /feedback <text> must drop a prior bare-/feedback arm so the
      // next normal prompt is not stolen as survey text.
      cancelFeedbackCapture();
      const status = captureFeedback(getTelemetry(), text, {
        turnTraceId: getLastTurnTraceId(),
      });
      return feedbackResultMessage(status);
    },
    beginFeedbackCapture: () => {
      armFeedbackCapture();
    },
  };

  const applyCommandResult = (result: CommandResult): void => {
    switch (result.type) {
      case "message":
        state.systemNotice?.(result.text);
        return;
      case "send":
        // A command the operator typed and submitted at the prompt — same
        // provenance as a plain-text send, just composed by the command
        // handler instead of typed verbatim.
        void state.sendWithAttemptIdentity?.(userInboundMessage(result.text, []));
        return;
      case "workflow":
        state.systemNotice?.(services.workflowController.start(result.name));
        return;
      case "noop":
        return;
      case "overlay":
        if (!hostOf(state).openSurface(result.overlay)) {
          const named = result.overlay === "add-provider" ? "connect" : result.overlay;
          state.systemNotice?.(`No surface for /${named}.`);
        }
        return;
      case "modal":
        // /model is the only modal reachable from a command; provider login is
        // reached from the picker itself.
        if (result.modal === "agent" && hostOf(state).openSurface("models")) return;
        state.systemNotice?.(`${result.modal} is not available in this renderer yet`);
        return;
      case "view":
        state.systemNotice?.(`${result.view} is not available in this renderer yet`);
        return;
      case "paste-image":
        void attachClipboardImage(hostOf(state).shell);
        return;
    }
  };

  const dispatchCommand = (name: string, args: string): void => {
    const command = getCommand(name);
    if (command === undefined) {
      state.systemNotice?.(`Unknown command: ${name}`);
      return;
    }
    // Plugins register into the same command registry as the built-ins, so an
    // unrecognised name is plugin-authored and is bucketed rather than sent.
    // Shared emitter so TUI and any headless path report the same event.
    captureSlashCommand(getTelemetry(), command.name);
    applyCommandResult(command.handler(args, commandContext));
  };
  state.dispatchCommand = dispatchCommand;
  return { currentAttemptIdentity, commandContext };
}
