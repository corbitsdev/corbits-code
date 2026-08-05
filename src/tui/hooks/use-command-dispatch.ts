import type { Dispatch, SetStateAction } from "react";
import type { CommandResult } from "../commands/registry.js";
import type { PermissionsAdmin, ScopedApproval } from "../../permission/admin.js";
import type { PluginsAdmin } from "../components/plugins-manager.js";
import type { ProviderCatalogEntry } from "../../config/index.js";
import type { ReasoningEffort } from "../../provider/reasoning-effort.js";
import type { Settings, ProviderTier, TierConfig } from "../../config/settings.js";
import { tierDefinitionAt } from "../../config/settings.js";
import type { LoginModal } from "./use-provider-auth.js";
import type { OutboundUserMessage } from "../message-types.js";
import { codexProfileFromProviderName } from "../../config/codex-providers.js";
import { xaiProfileFromProviderName } from "../../config/xai-providers.js";
import { fetchCodexUsage, formatCodexUsage } from "../../auth/codex/usage.js";
import { fetchXaiUsage, formatXaiUsage } from "../../auth/xai/usage.js";
import { workflowKickoffUserMessage } from "../../workflows/kickoff.js";

export type UseCommandDispatchArgs = {
  handleSend: (text: string) => void;
  setCommandMessage: (message: string | null) => void;
  providerCatalog: ProviderCatalogEntry[];
  tiers: Partial<Record<ProviderTier, TierConfig>>;
  applySelection: (provider: string, model: string, reasoningEffort?: ReasoningEffort) => void;
  reasoningEffort: ReasoningEffort | undefined;
  setTasksExpanded: Dispatch<SetStateAction<boolean>>;
  permissionsAdmin: PermissionsAdmin | undefined;
  setPermissionEntries: Dispatch<SetStateAction<ScopedApproval[]>>;
  setPermissionsOpen: Dispatch<SetStateAction<boolean>>;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  pluginsAdmin: PluginsAdmin | undefined;
  setPluginsOpen: Dispatch<SetStateAction<boolean>>;
  setHelpOpen: Dispatch<SetStateAction<boolean>>;
  setAgentModalOpen: Dispatch<SetStateAction<boolean>>;
  refreshAuthState: () => void;
  provider: string;
  setAgentModalUsage: Dispatch<SetStateAction<string | null>>;
  setLoginModal: Dispatch<SetStateAction<LoginModal>>;
  handlePasteImage: () => void;
  onStartWorkflow: ((name: string) => string) | undefined;
  sendMessage: (message: OutboundUserMessage) => void;
};

export type CommandDispatchController = {
  handleCommand: (result: CommandResult) => void;
  refreshPermissions: () => void;
  handleRevokePermission: (entry: ScopedApproval) => void;
};

/** Dispatches slash-command results (`CommandResult`) to the relevant piece
 * of app state — overlays, the agent modal, workflows, tier switching — and
 * owns the permissions-admin refresh/revoke round trip used by those overlays. */
export function useCommandDispatch({
  handleSend,
  setCommandMessage,
  providerCatalog,
  tiers,
  applySelection,
  reasoningEffort,
  setTasksExpanded,
  permissionsAdmin,
  setPermissionEntries,
  setPermissionsOpen,
  setSettingsOpen,
  pluginsAdmin,
  setPluginsOpen,
  setHelpOpen,
  setAgentModalOpen,
  refreshAuthState,
  provider,
  setAgentModalUsage,
  setLoginModal,
  handlePasteImage,
  onStartWorkflow,
  sendMessage,
}: UseCommandDispatchArgs): CommandDispatchController {
  const refreshPermissions = (): void => {
    if (permissionsAdmin === undefined) return;
    void permissionsAdmin.list().then(setPermissionEntries);
  };

  const handleRevokePermission = (entry: ScopedApproval): void => {
    if (permissionsAdmin === undefined) return;
    void permissionsAdmin.revoke(entry).then(refreshPermissions);
  };

  const handleCommand = (result: CommandResult): void => {
    if (result.type === "send") {
      handleSend(result.text);
      return;
    }
    if (result.type === "message") {
      setCommandMessage(result.text);
      return;
    }
    if (result.type === "tier") {
      // Resolve strictly against the named tier (no fast→standard→clever
      // fallback walk) so /fast means "the fast tier's model", not "whatever
      // resolves." Provider names come from the live catalog so a tier assigned
      // this session is recognised without a restart.
      const settings: Settings = {
        providers: Object.fromEntries(providerCatalog.map((p) => [p.name, p])),
        tiers,
      };
      const leg = tierDefinitionAt(result.tier, settings)?.order[0];
      if (leg === undefined) {
        setCommandMessage(`The ${result.tier} tier is not configured. Assign it in /model.`);
        return;
      }
      applySelection(leg.provider, leg.model, reasoningEffort);
      setCommandMessage(`Switched to ${result.tier} tier (${leg.model}).`);
      return;
    }
    if (result.type === "view") {
      setTasksExpanded(true);
      return;
    }
    if (result.type === "overlay") {
      if (result.overlay === "permissions") {
        refreshPermissions();
        setPermissionsOpen(true);
      } else if (result.overlay === "settings") {
        refreshPermissions();
        setSettingsOpen(true);
      } else if (result.overlay === "plugins") {
        if (pluginsAdmin === undefined) {
          setCommandMessage("Plugins are not available in this context.");
        } else {
          setPluginsOpen(true);
        }
      } else {
        setHelpOpen(true);
      }
      return;
    }
    if (result.type === "modal" && result.modal === "agent") {
      setAgentModalOpen(true);
      refreshAuthState();
      const codexName = codexProfileFromProviderName(provider);
      const xaiName = xaiProfileFromProviderName(provider);
      setAgentModalUsage(null);
      if (codexName !== undefined) {
        void fetchCodexUsage(codexName).then(
          (usage) => {
            setAgentModalUsage(formatCodexUsage(usage));
          },
          () => setAgentModalUsage(null),
        );
      } else if (xaiName !== undefined) {
        const entry = providerCatalog.find((e) => e.name === provider);
        void fetchXaiUsage(xaiName, entry?.baseURL).then(
          (usage) => {
            setAgentModalUsage(formatXaiUsage(usage));
          },
          () => setAgentModalUsage(null),
        );
      } else {
        setAgentModalUsage(null);
      }
    }
    if (result.type === "modal" && (result.modal === "codex-login" || result.modal === "xai-login")) {
      setLoginModal(result.modal === "xai-login" ? "xai" : "codex");
    }
    if (result.type === "paste-image") {
      handlePasteImage();
      return;
    }
    if (result.type === "workflow") {
      if (onStartWorkflow === undefined) {
        setCommandMessage("Workflows are not available in this context.");
      } else {
        const msg = onStartWorkflow(result.name);
        if (msg.startsWith("Started")) {
          sendMessage({ text: workflowKickoffUserMessage(result.args), attachments: [] });
        } else {
          setCommandMessage(msg);
        }
      }
    }
  };

  return { handleCommand, refreshPermissions, handleRevokePermission };
}
