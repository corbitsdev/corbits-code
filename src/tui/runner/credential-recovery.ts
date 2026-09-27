import type { InboundMessage } from "@intx/types/runtime";
import type { Config } from "../../config/index.js";
import { buildMainSessionSources } from "../../config/inference-sources.js";
import { isOperatorOriginated } from "../../agent/message-provenance.js";
import { CREDENTIAL_RECOVERY_INTERCHANGE_TYPE } from "../../agent/director.js";
import { formatModelPickerLabel, modelOptionId } from "../model-catalog.js";

export interface CredentialRecoveryAlternative {
  readonly id: string;
  readonly label: string;
  readonly provider: string;
  readonly model: string;
}

export interface PendingCredentialRecovery {
  readonly generation: number;
  readonly failedProvider: string;
  readonly message: InboundMessage;
  readonly committed: boolean;
  readonly alternatives: readonly CredentialRecoveryAlternative[];
}

export interface CredentialRecoveryAttempt {
  readonly generation: number;
  failedProvider: string;
  readonly message: InboundMessage;
  committed: boolean;
  sawCredentialRetry: boolean;
  terminalCredentialFailure: boolean;
}

type RecoveryEvent = {
  readonly type: string;
  readonly data?: unknown;
};

type RecoveryEventData = {
  readonly previousError?: { readonly category?: string };
  readonly error?: {
    readonly category?: string;
    readonly providerId?: string;
  };
};

function recoveryEventData(
  event: RecoveryEvent,
): RecoveryEventData | undefined {
  if (typeof event.data !== "object" || event.data === null) return undefined;
  return event.data as RecoveryEventData;
}

export type CredentialRecoveryAcceptance =
  | { readonly kind: "stale" }
  | { readonly kind: "invalid" }
  | {
      readonly kind: "accepted";
      readonly generation: number;
      readonly alternative: CredentialRecoveryAlternative;
      readonly replay: boolean;
    };

function isHarnessCommittingEvent(event: RecoveryEvent): boolean {
  if (!event.type.startsWith("inference.")) return false;
  // Keep the exact harness.ts isCommitting set. runInference handles these
  // wrapper terminal events before consulting that predicate.
  switch (event.type) {
    case "inference.start":
    case "inference.usage":
    case "inference.done":
    case "inference.error":
    case "inference.retry":
      return false;
    default:
      return true;
  }
}

export function createCredentialRecoveryState() {
  let nextGeneration = 0;
  let pending: PendingCredentialRecovery | null = null;

  return {
    begin(
      message: InboundMessage,
      failedProvider: string,
    ): CredentialRecoveryAttempt {
      if (isOperatorOriginated(message.flags)) pending = null;
      return {
        generation: ++nextGeneration,
        failedProvider,
        message,
        committed: false,
        sawCredentialRetry: false,
        terminalCredentialFailure: false,
      };
    },
    observe(attempt: CredentialRecoveryAttempt, event: RecoveryEvent): void {
      if (attempt.generation !== nextGeneration) return;
      if (isHarnessCommittingEvent(event)) attempt.committed = true;
      const data = recoveryEventData(event);
      if (
        event.type === "inference.retry" &&
        data?.previousError?.category === "credential_failure"
      ) {
        attempt.sawCredentialRetry = true;
      }
      if (event.type === "inference.error") {
        attempt.terminalCredentialFailure =
          data?.error?.category === "credential_failure";
        const providerId = data?.error?.providerId;
        if (providerId !== undefined && providerId.length > 0) {
          attempt.failedProvider = providerId;
        }
      }
    },
    settle(
      attempt: CredentialRecoveryAttempt,
      alternatives: readonly CredentialRecoveryAlternative[],
    ): PendingCredentialRecovery | null {
      if (
        attempt.generation !== nextGeneration ||
        !isOperatorOriginated(attempt.message.flags) ||
        !attempt.sawCredentialRetry ||
        !attempt.terminalCredentialFailure ||
        alternatives.length === 0
      ) {
        return null;
      }
      pending = {
        generation: attempt.generation,
        failedProvider: attempt.failedProvider,
        message: attempt.message,
        committed: attempt.committed,
        alternatives: [...alternatives],
      };
      return pending;
    },
    cancel(generation: number): boolean {
      if (pending?.generation !== generation) return false;
      pending = null;
      return true;
    },
    accept(
      generation: number,
      alternativeId: string,
    ): CredentialRecoveryAcceptance {
      if (pending?.generation !== generation) return { kind: "stale" };
      const claimed = pending;
      pending = null;
      const alternative = claimed.alternatives.find(
        (candidate) => candidate.id === alternativeId,
      );
      if (alternative === undefined) return { kind: "invalid" };
      return {
        kind: "accepted",
        generation,
        alternative,
        replay: !claimed.committed,
      };
    },
    clear(): void {
      pending = null;
      nextGeneration++;
    },
  };
}

export function applyCredentialRecoverySelection(args: {
  state: ReturnType<typeof createCredentialRecoveryState>;
  generation: number;
  alternativeId: string;
  switchAlternative: (alternative: CredentialRecoveryAlternative) => void;
  armContinuation: (generation: number) => void;
  cancelContinuation: (generation: number) => void;
  deliverContinuation: (message: InboundMessage) => void;
}): "stale" | "invalid" | "switch-failed" | "switched" | "continued" {
  const acceptance = args.state.accept(args.generation, args.alternativeId);
  if (acceptance.kind !== "accepted") return acceptance.kind;
  try {
    args.switchAlternative(acceptance.alternative);
  } catch {
    return "switch-failed";
  }
  if (!acceptance.replay) return "switched";
  args.armContinuation(acceptance.generation);
  try {
    args.deliverContinuation(
      buildCredentialRecoveryContinuationMessage(acceptance.generation),
    );
  } catch {
    args.cancelContinuation(acceptance.generation);
    return "switched";
  }
  return "continued";
}

export function buildCredentialRecoveryAlternatives(
  config: Pick<
    Config,
    "providers" | "providerName" | "model" | "settings" | "reasoningEffort"
  >,
  sessionId: string,
  failedProvider: string,
): CredentialRecoveryAlternative[] {
  const alternatives: CredentialRecoveryAlternative[] = [];
  const seen = new Set<string>();

  for (const entry of config.providers) {
    if (entry.name === failedProvider) continue;
    for (const rawModel of entry.models ?? []) {
      const model = rawModel.trim();
      if (model.length === 0) continue;
      const id = modelOptionId(entry.name, model);
      if (seen.has(id)) continue;
      try {
        buildMainSessionSources({
          settings: config.settings,
          catalog: config.providers,
          activeProvider: entry.name,
          activeModel: model,
          sessionId,
          ...(config.reasoningEffort !== undefined
            ? { reasoningEffort: config.reasoningEffort }
            : {}),
        });
      } catch {
        continue;
      }
      seen.add(id);
      alternatives.push({
        id,
        provider: entry.name,
        model,
        label: formatModelPickerLabel(model, entry.name),
      });
    }
  }

  return alternatives;
}

export function buildCredentialRecoveryContinuationMessage(
  generation: number,
): InboundMessage {
  return {
    ref: { uid: 0, mailbox: "system" },
    headers: {
      from: "user@local",
      to: ["agent@local"],
      date: new Date().toISOString(),
      messageId: `credential-recovery-${generation}@local`,
      interchangeType: CREDENTIAL_RECOVERY_INTERCHANGE_TYPE,
      interchangeCorrelationId: String(generation),
    },
    flags: [],
    content: "",
    signatureStatus: "missing",
  };
}
