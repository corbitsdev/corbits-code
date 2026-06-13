import type { ReactNode } from "react";
import type { LifecycleHookStatus } from "../../session/hooks.js";
import type { ApprovalOutcome, PermissionRequest } from "../../permission/types.js";
import type { PlanStep } from "../use-stream.js";
import { HookPanel } from "./hook-panel.js";
import { HelpOverlay } from "./help-overlay.js";
import { AgentModal, toAgentProviders, type AgentProvider, type ProviderFormSubmission } from "./agent-modal.js";
import type { ReasoningEffort } from "../../provider/reasoning-effort.js";
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
  activeEffort: ReasoningEffort;
  onAgentApply: (provider: string, model: string, effort: ReasoningEffort) => void;
  onAgentPersistDefault: (provider: string, model: string, effort: ReasoningEffort) => void;
  onAgentSaveProvider: (provider: ProviderFormSubmission) => { ok: true } | { ok: false; error: string };
  onAgentDeleteProvider: (provider: string) => void;
  onCloseAgentModal: () => void;

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
        />
      )}
      {pendingPlan !== null && (
        <ApprovalModal plan={pendingPlan} onApprove={onApprove} onReject={onReject} />
      )}
      {pendingOperator !== null && (
        <OperatorModal
          question={pendingOperator.question}
          options={pendingOperator.options}
          onSelect={onSelectOperator}
        />
      )}
      {pendingPermission !== null && (
        <PermissionModal request={pendingPermission} onResolve={onResolvePermission} {...(width !== undefined ? { width } : {})} />
      )}
    </>
  );
}
