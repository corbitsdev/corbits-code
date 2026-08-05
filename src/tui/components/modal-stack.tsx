import { Box, Text, useInput } from "ink";
import type { ReactNode } from "react";
import type { LifecycleHookStatus } from "../../session/hooks.js";
import type { ApprovalOutcome } from "../../permission/types.js";
import type { PlanStep } from "../use-stream.js";
import type { ActiveApproval, QueuedApprovalSummary } from "../hooks/use-gates.js";
import { HookPanel } from "./hook-panel.js";
import { HelpOverlay } from "./help-overlay.js";
import { AgentModal, toAgentProviders, type AgentProvider, type ProviderFormSubmission } from "./agent-modal.js";
import type { ReasoningEffort } from "../../provider/reasoning-effort.js";
import type { ProviderTier } from "../../config/settings.js";
import type { AgentProfile } from "../../agent/profiles.js";
import { OperatorModal } from "./operator-modal.js";
import { color } from "../theme.js";

function ApprovalModal({ plan, onApprove, onReject }: { plan: PlanStep[]; onApprove: () => void; onReject: () => void }): ReactNode {
  useInput((_input, key) => {
    if (key.return) onApprove();
    if (key.escape) onReject();
  });
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1} marginX={1} marginY={1}>
      <Text bold color={color("accent")}>Plan Review</Text>
      <Box flexDirection="column" marginTop={1}>
        {plan.map((step, i) => (
          <Text key={i} color={color("muted")}>{`  ${step.file}  ${step.action}`}</Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={color("muted")}>Enter to approve · Esc to reject</Text>
      </Box>
    </Box>
  );
}
import type { OperatorResult } from "../../agent/tools.js";
import { PermissionModal } from "./permission-modal.js";

export type ModalStackProps = {
  hooks: LifecycleHookStatus[];
  hookPanelOpen: boolean;

  helpOpen: boolean;
  onCloseHelp: () => void;

  agentModalOpen: boolean;
  agentProviders: AgentProvider[];
  activeProvider: string;
  activeModel: string;
  activeEffort: ReasoningEffort | undefined;
  onAgentApply: (provider: string, model: string, effort: ReasoningEffort | undefined) => void;
  onAgentPersistDefault: (provider: string, model: string, effort: ReasoningEffort | undefined) => void;
  onAgentSaveProvider: (provider: ProviderFormSubmission) => { ok: true } | { ok: false; error: string };
  onAgentDeleteProvider: (provider: string) => void;
  onCloseAgentModal: () => void;
  agentTiers: Partial<Record<ProviderTier, import("../../config/settings.js").TierConfig>>;
  onSaveTier: (
    tier: ProviderTier,
    provider: string,
    model: string,
    effort?: import("../../provider/reasoning-effort.js").ReasoningEffort,
  ) => void;
  onCycleTierMode?: (tier: ProviderTier) => void;
  onClearTier?: (tier: ProviderTier) => void;
  onRemoveTierLeg?: (tier: ProviderTier, legIndex: number) => void;
  onMoveTierLeg?: (tier: ProviderTier, legIndex: number, direction: -1 | 1) => void;
  agentProfiles: AgentProfile[];
  onSaveAgentProfile: (profile: AgentProfile) => { ok: true } | { ok: false; error: string };
  onDeleteAgentProfile: (id: string) => void;
  usage?: string | undefined;
  /** Forwarded to AgentModal for live usage fetch on hover/select of codex/xai providers. */
  onRequestAgentUsage?: (kind: "codex" | "xai", profile: string, baseURL?: string) => void;
  unauthedProviders?: ReadonlySet<string>;
  onRequestAgentLogin?: (kind: "codex" | "xai", profile: string) => void;
  recentModels?: import("../../config/settings.js").ModelRef[];
  favoriteModels?: import("../../config/settings.js").ModelRef[];
  onToggleFavorite?: (ref: import("../../config/settings.js").ModelRef) => void;

  activeApproval: ActiveApproval | null;
  onApprove: (id: number) => void;
  onReject: (id: number) => void;
  onSelectOperator: (id: number, result: OperatorResult) => void;
  permissionQueueDepth?: number;
  queuedApprovals?: readonly QueuedApprovalSummary[];
  onResolvePermission: (id: number, outcome: ApprovalOutcome) => void;
  /** Terminal height, so approval bodies taller than it scroll instead of
   * pushing the choices off screen. */
  terminalRows?: number;


  width?: number;
};

export function ModalStack({
  hooks,
  hookPanelOpen,
  helpOpen,
  onCloseHelp,
  agentModalOpen,
  agentProviders,
  activeProvider,
  activeModel,
  activeEffort,
  onAgentApply,
  onAgentPersistDefault,
  onAgentSaveProvider,
  onAgentDeleteProvider,
  onCloseAgentModal,
  agentTiers,
  onSaveTier,
  onCycleTierMode,
  onClearTier,
  onRemoveTierLeg,
  onMoveTierLeg,
  agentProfiles,
  onSaveAgentProfile,
  onDeleteAgentProfile,
  usage,
  onRequestAgentUsage,
  unauthedProviders,
  onRequestAgentLogin,
  recentModels,
  favoriteModels,
  onToggleFavorite,
  activeApproval,
  onApprove,
  onReject,
  onSelectOperator,
  permissionQueueDepth,
  queuedApprovals,
  onResolvePermission,
  width,
  terminalRows,
}: ModalStackProps): ReactNode {

  return (
    <>
      {hookPanelOpen ? <HookPanel hooks={hooks} /> : null}
      {helpOpen && <HelpOverlay onClose={onCloseHelp} />}
      {agentModalOpen && (
        <AgentModal
          providers={agentProviders}
          activeProvider={activeProvider}
          activeModel={activeModel}
          activeEffort={activeEffort}
          onApply={onAgentApply}
          onPersistDefault={onAgentPersistDefault}
          onSaveProvider={onAgentSaveProvider}
          onDeleteProvider={onAgentDeleteProvider}
          onClose={onCloseAgentModal}
          tiers={agentTiers}
          onSaveTier={onSaveTier}
          {...(onCycleTierMode !== undefined ? { onCycleTierMode } : {})}
          {...(onClearTier !== undefined ? { onClearTier } : {})}
          {...(onRemoveTierLeg !== undefined ? { onRemoveTierLeg } : {})}
          {...(onMoveTierLeg !== undefined ? { onMoveTierLeg } : {})}
          profiles={agentProfiles}
          onSaveProfile={onSaveAgentProfile}
          onDeleteProfile={onDeleteAgentProfile}
          usage={usage}
          {...(onRequestAgentUsage !== undefined ? { onRequestUsage: onRequestAgentUsage } : {})}
          {...(unauthedProviders !== undefined ? { unauthedProviders } : {})}
          {...(onRequestAgentLogin !== undefined ? { onRequestLogin: onRequestAgentLogin } : {})}
          {...(recentModels !== undefined ? { recentModels } : {})}
          {...(favoriteModels !== undefined ? { favoriteModels } : {})}
          {...(onToggleFavorite !== undefined ? { onToggleFavorite } : {})}
        />
      )}
      {activeApproval?.kind === "plan" && (
        <ApprovalModal
          key={activeApproval.id}
          plan={activeApproval.plan}
          onApprove={() => onApprove(activeApproval.id)}
          onReject={() => onReject(activeApproval.id)}
        />
      )}
      {activeApproval?.kind === "operator" && (
        <OperatorModal
          key={activeApproval.id}
          question={activeApproval.question}
          options={activeApproval.options}
          onSelect={(result) => onSelectOperator(activeApproval.id, result)}
          {...(width !== undefined ? { width } : {})}
          {...(terminalRows !== undefined ? { terminalRows } : {})}
        />
      )}
      {activeApproval?.kind === "permission" && (
        <PermissionModal
          key={activeApproval.id}
          request={activeApproval.request}
          {...(permissionQueueDepth !== undefined ? { permissionQueueDepth } : {})}
          {...(queuedApprovals !== undefined ? { queuedApprovals } : {})}
          {...(terminalRows !== undefined ? { terminalRows } : {})}
          {...(activeApproval.timeoutMs !== null ? { goalTimeoutMs: activeApproval.timeoutMs } : {})}
          onResolve={(outcome) => onResolvePermission(activeApproval.id, outcome)}
          {...(width !== undefined ? { width } : {})}
        />
      )}

    </>
  );
}
