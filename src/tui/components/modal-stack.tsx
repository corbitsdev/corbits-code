import type { ReactNode } from "react";
import type { LifecycleHookStatus } from "../../session/hooks.js";
import type { ApprovalOutcome, PermissionRequest } from "../../permission/types.js";
import type { PlanStep } from "../use-stream.js";
import { HookPanel } from "./hook-panel.js";
import { HelpOverlay } from "./help-overlay.js";
import { AgentModal, toAgentProviders, type AgentProvider, type ProviderFormSubmission } from "./agent-modal.js";
import type { ReasoningEffort } from "../../provider/reasoning-effort.js";
import type { ProviderTier, TierAssignment } from "../../config/settings.js";
import type { AgentProfile } from "../../agent/profiles.js";
import { ApprovalModal } from "./approval-modal.js";
import { OperatorModal } from "./operator-modal.js";
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
  agentTiers: Partial<Record<ProviderTier, TierAssignment>>;
  onSaveTier: (tier: ProviderTier, provider: string, model: string) => void;
  agentProfiles: AgentProfile[];
  onSaveAgentProfile: (profile: AgentProfile) => { ok: true } | { ok: false; error: string };
  onDeleteAgentProfile: (id: string) => void;
  codexUsage?: string | undefined;

  pendingPlan: PlanStep[] | null;
  onApprove: () => void;
  onReject: () => void;

  pendingOperator: { question: string; options: string[] } | null;
  onSelectOperator: (index: number) => void;

  pendingPermission: PermissionRequest | null;
  onResolvePermission: (outcome: ApprovalOutcome) => void;

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
  agentProfiles,
  onSaveAgentProfile,
  onDeleteAgentProfile,
  codexUsage,
  pendingPlan,
  onApprove,
  onReject,
  pendingOperator,
  onSelectOperator,
  pendingPermission,
  onResolvePermission,
  width,
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
          profiles={agentProfiles}
          onSaveProfile={onSaveAgentProfile}
          onDeleteProfile={onDeleteAgentProfile}
          codexUsage={codexUsage}
        />
      )}
      {pendingPlan !== null && (
        <ApprovalModal plan={pendingPlan} onApprove={onApprove} onReject={onReject} {...(width !== undefined ? { width } : {})} />
      )}
      {pendingOperator !== null && (
        <OperatorModal
          question={pendingOperator.question}
          options={pendingOperator.options}
          onSelect={onSelectOperator}
          {...(width !== undefined ? { width } : {})}
        />
      )}
      {pendingPermission !== null && (
        <PermissionModal request={pendingPermission} onResolve={onResolvePermission} {...(width !== undefined ? { width } : {})} />
      )}
    </>
  );
}
