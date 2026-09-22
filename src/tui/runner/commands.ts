/**
 * Command layer for the TUI runner: slash-command registry population, the
 * command context the handlers run against, and result surfacing.
 */

import { getLogger } from "@intx/log";
import type { ConversationTurn } from "@intx/types/runtime";
import { compactFloorNoopNotice } from "../../agent/compaction.js";
import type { CommandContext, CommandResult } from "../commands/registry.js";
import { getCommand, setHiddenCommands } from "../commands/registry.js";
import { registerBuiltInCommands } from "../commands/built-in.js";
import {
  registerCommandPlugins,
  registerWorkflowPlugins,
} from "../../plugins/register.js";
import type { PluginModule } from "../../plugins/loader.js";
import type { PluginConfig } from "../../config/settings.js";
import {
  persistSkipPermissionsDefault,
  type Settings,
} from "../../config/settings.js";
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
import { attachClipboardImage, setPromptModelLabel } from "../shell/prompt.js";
import { yoloModeLabel } from "../components/prompt-action-bar-label.js";
import { isCodexProviderName } from "../../config/codex-providers.js";
import { resolveSessionEffort } from "../../provider/reasoning-effort.js";
import type { InferenceAttemptIdentity } from "./state.js";
import {
  hostOf,
  liveAgent,
  type RunnerServices,
  type RunnerState,
} from "./state.js";
import { userInboundMessage } from "./submit.js";
import { LOG_NAMESPACE_ROOT } from "../../branding.js";
import { buildCompactionContinuationMessage } from "../../session/runtime-assembly.js";

const tuiLogger = getLogger([LOG_NAMESPACE_ROOT, "tui"]);

/**
 * Pivot text delivered as the next turn when `/handoff` is invoked without
 * trailing instructions. The fold already wrote the structured summary, so
 * this only needs to point the fresh inference at it.
 */
export const HANDOFF_DEFAULT_PIVOT = "Continue from the handoff summary above.";

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
  getPluginConfig: () => Record<string, PluginConfig> = () =>
    settings?.plugins ?? {},
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
export function createCommandLayer(
  state: RunnerState,
  services: RunnerServices,
): CommandLayer {
  const currentAttemptIdentity = (): InferenceAttemptIdentity => {
    const displayLabel =
      state.config.settings?.providers[state.config.providerName]?.name;
    return {
      providerId: state.config.providerName,
      ...(displayLabel !== undefined ? { displayLabel } : {}),
    };
  };
  state.currentAttemptIdentity = currentAttemptIdentity;

  let compactHydrateInFlight = false;

  const commandContext: CommandContext = {
    signalClear: () => state.newSession?.(),
    getSkipPermissions: () => services.permissionGate.getSkipPermissions(),
    setSkipPermissions: (value: boolean) => {
      services.permissionGate.setSkipPermissions(value);
      state.config.dangerouslySkipPermissions = value;
      const effort = resolveSessionEffort(
        state.config.model,
        state.config.reasoningEffort,
        isCodexProviderName(state.config.providerName),
      );
      setPromptModelLabel(hostOf(state).shell, {
        profile: state.config.providerName,
        model: state.config.model,
        ...(effort !== undefined ? { effort } : {}),
        mode: yoloModeLabel(value),
      });
      void services.globalSettingsWriter.enqueue(async () => {
        try {
          const result = await persistSkipPermissionsDefault(
            state.config.globalSettingsPath,
            value,
          );
          if (result === "skipped") {
            state.systemNotice?.(
              "Yolo flipped for this session, but the default did not stick.",
            );
          }
        } catch (err: unknown) {
          tuiLogger.debug("skip-permissions persist failed: {error}", {
            error: err instanceof Error ? err.message : String(err),
          });
          state.systemNotice?.(
            "Yolo flipped for this session, but the default did not stick.",
          );
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
      const contextEstimate =
        services.directorHolder.instance?.getContextEstimate();
      const isEstimate =
        contextEstimate !== undefined && contextEstimate.isEstimate;
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
        contextTokens: isEstimate
          ? contextEstimate.tokens
          : contextTokensFromUsage(lastTurnUsage),
        contextIsEstimate: isEstimate,
        sessionBillingMix: billed.mix,
        sessionHiddenReason: billed.hiddenReason,
      });
      return maskContextMeterWhenNoTurns(
        summary,
        services.runSink.getTurnCount(),
      );
    },
    startWorkflow: (name) => services.workflowHost.start(name),
    getFleetStatus: () =>
      fleetDigest(services.subAgentSessions.list(), Date.now()),
    renameSession: (name) => {
      const trimmed = name.trim();
      if (trimmed.length === 0) return "Session name cannot be empty";
      state.runTaskTitle = trimmed;
      services.emitter.emit(
        "session.title",
        truncateSessionLabel(state.runTaskTitle),
      );
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
    requestCompact: (instructions) => {
      const director = services.directorHolder.instance;
      const agent = state.currentAgent;
      if (director === undefined || agent === undefined) {
        return "Compaction is not available in this session.";
      }
      if (
        state.compactionLifecycle?.isCompacting() === true ||
        compactHydrateInFlight
      ) {
        return "Compaction is already in progress.";
      }
      const arm = (turns?: ConversationTurn[]) => {
        const inFlight = state.host?.shell.session.run === "busy";
        const arming = director.requestManualCompact(instructions, {
          inFlight,
          ...(turns !== undefined ? { turns } : {}),
        });
        if (arming === "noop") return compactFloorNoopNotice(instructions);
        if (arming === "kick") {
          state.enqueueCompactionContinuation?.(() =>
            liveAgent(state).deliver(buildCompactionContinuationMessage()),
          );
        }
        return undefined;
      };
      if (director.getCompactTurnCount() > 0) return arm();
      // Resume (or a just-built agent) has not decided yet, so the governor's
      // turn count is still 0. Load committed history before no-op'ing.
      compactHydrateInFlight = true;
      void agent
        .history()
        .then((turns) => {
          compactHydrateInFlight = false;
          const err = arm(turns);
          if (err !== undefined) state.systemNotice?.(err);
        })
        .catch((err: unknown) => {
          compactHydrateInFlight = false;
          tuiLogger.warn("compact history load failed: {error}", {
            error: err instanceof Error ? err.message : String(err),
          });
          state.systemNotice?.("Could not read session history to compact.");
        });
      return undefined;
    },
    requestHandoff: (instructions: string) => {
      const director = services.directorHolder.instance;
      if (director === undefined) {
        return "Handoff is not available in this session.";
      }
      const send = state.sendWithAttemptIdentity;
      if (send === undefined) {
        return "Handoff is not available in this session.";
      }
      const trimmed = instructions.trim();
      const arming = director.requestHandoff(instructions);
      if (arming === "noop" && trimmed.length === 0) {
        return "Nothing to hand off yet — the conversation is too short to fold.";
      }
      // The pivot rides the serial send path, so a busy session queues it
      // behind the in-flight tool batch: whichever boundary fires first runs
      // the single operator fold (a tool pause compacts-then-continues, the
      // pivot arrival folds-then-infers), because firing clears the arming.
      // Unlike `/compact`, the pivot is always delivered, so handoff always
      // starts the next assistant turn — even a "noop" fold still pivots to
      // the operator's new goal without needing `/clear`.
      const pivot = trimmed.length > 0 ? trimmed : HANDOFF_DEFAULT_PIVOT;
      const disarmOnMiss = arming === "armed";
      void send(userInboundMessage(pivot, [])).then(
        (result) => {
          // A pivot that never delivered must not leave a stale arming behind
          // to fold the next innocent operator message. Noop never armed, so
          // cancel would restore snapshots from a prior fold and wipe extras.
          if (disarmOnMiss && result.status !== "accepted") {
            director.cancelManualCompact();
          }
        },
        () => {
          if (disarmOnMiss) director.cancelManualCompact();
        },
      );
      return undefined;
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
        void state.sendWithAttemptIdentity?.(
          userInboundMessage(result.text, []),
        );
        return;
      case "workflow":
        state.systemNotice?.(services.workflowHost.start(result.name));
        return;
      case "noop":
        return;
      case "overlay":
        if (!hostOf(state).openSurface(result.overlay)) {
          const named =
            result.overlay === "add-provider" ? "connect" : result.overlay;
          state.systemNotice?.(`No surface for /${named}.`);
        }
        return;
      case "modal":
        // /model is the only modal reachable from a command; provider login is
        // reached from the picker itself.
        if (result.modal === "agent" && hostOf(state).openSurface("models"))
          return;
        state.systemNotice?.(
          `${result.modal} is not available in this renderer yet`,
        );
        return;
      case "view":
        state.systemNotice?.(
          `${result.view} is not available in this renderer yet`,
        );
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
