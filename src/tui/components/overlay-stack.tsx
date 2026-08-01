import type { ReactNode } from "react";
import { PermissionsManager } from "./permissions-manager.js";
import { SettingsOverlay, type CompactionMode } from "./settings-overlay.js";
import { PluginsManager, type PluginsAdmin } from "./plugins-manager.js";
import { LoginProviderPicker } from "./login-provider-picker.js";
import { CodexLoginModal } from "./codex-login-modal.js";
import type { ScopedApproval } from "../../permission/admin.js";
import type { LoginModal } from "../hooks/use-provider-auth.js";
import { startCodexLogin } from "../../auth/codex/login.js";
import { startXaiLogin } from "../../auth/xai/login.js";

export type OverlayStackProps = {
  permissionsOpen: boolean;
  permissionEntries: ScopedApproval[];
  onRevokePermission: (entry: ScopedApproval) => void;
  onClosePermissions: () => void;
  permissionsOverlayRows: number;

  settingsOpen: boolean;
  compactionMode: CompactionMode;
  onChangeCompactionMode: (mode: CompactionMode) => void;
  maxConcurrentSubAgents: number;
  onChangeMaxConcurrentSubAgents: (limit: number) => void;
  sessionMode: import("../../config/session-mode.js").SessionMode;
  savedGlobalSessionMode?: import("../../config/session-mode.js").SessionMode;
  savedLocalSessionMode?: import("../../config/session-mode.js").SessionMode;
  onChangeSessionMode: (
    mode: import("../../config/session-mode.js").SessionMode,
    scope: "global" | "local",
  ) => void;
  telemetryEnabled: boolean;
  onChangeTelemetryEnabled: (enabled: boolean) => void;
  waitForApproval: boolean;
  onChangeWaitForApproval: (value: boolean) => void;
  onCloseSettings: () => void;

  pluginsOpen: boolean;
  pluginsAdmin: PluginsAdmin | undefined;
  onClosePlugins: () => void;
  cwd: string;

  loginModal: LoginModal;
  onSelectLoginProvider: (provider: LoginModal) => void;
  onCloseLoginModal: () => void;
  xaiProfileNames: string[];
  codexProfileNames: string[];
  activeProvider: string;
  autoLoginProfile: string | undefined;
  switchToXaiProfile: (profile: string) => void;
  switchToCodexProfile: (profile: string) => void;
  removeXaiProfileEverywhere: (profile: string) => void;
  removeCodexProfileEverywhere: (profile: string) => void;
};

/** Renders the overlays that sit outside the modal-stack's own accounting:
 * permissions manager, settings, plugins manager, and the login flow modals. */
export function OverlayStack(props: OverlayStackProps): ReactNode {
  return (
    <>
      {props.permissionsOpen && (
        <PermissionsManager
          entries={props.permissionEntries}
          onRevoke={props.onRevokePermission}
          onClose={props.onClosePermissions}
          maxHeight={props.permissionsOverlayRows}
        />
      )}
      {props.settingsOpen && (
        <SettingsOverlay
          permissionEntries={props.permissionEntries}
          onRevokePermission={props.onRevokePermission}
          compactionMode={props.compactionMode}
          onChangeCompactionMode={props.onChangeCompactionMode}
          maxConcurrentSubAgents={props.maxConcurrentSubAgents}
          onChangeMaxConcurrentSubAgents={props.onChangeMaxConcurrentSubAgents}
          sessionMode={props.sessionMode}
          {...(props.savedGlobalSessionMode !== undefined
            ? { savedGlobalSessionMode: props.savedGlobalSessionMode }
            : {})}
          {...(props.savedLocalSessionMode !== undefined
            ? { savedLocalSessionMode: props.savedLocalSessionMode }
            : {})}
          onChangeSessionMode={props.onChangeSessionMode}
          telemetryEnabled={props.telemetryEnabled}
          onChangeTelemetryEnabled={props.onChangeTelemetryEnabled}
          waitForApproval={props.waitForApproval}
          onChangeWaitForApproval={props.onChangeWaitForApproval}
          onClose={props.onCloseSettings}
          maxHeight={props.permissionsOverlayRows}
        />
      )}
      {props.pluginsOpen && props.pluginsAdmin !== undefined && (
        <PluginsManager admin={props.pluginsAdmin} onClose={props.onClosePlugins} cwd={props.cwd} />
      )}
      {props.loginModal === "choose" && (
        <LoginProviderPicker
          onSelect={props.onSelectLoginProvider}
          onClose={props.onCloseLoginModal}
        />
      )}
      {(props.loginModal === "codex" || props.loginModal === "xai") && (
        <CodexLoginModal
          profiles={props.loginModal === "xai" ? props.xaiProfileNames : props.codexProfileNames}
          activeProfile={props.activeProvider}
          providerPrefix={props.loginModal === "xai" ? "xai/" : "codex/"}
          title={props.loginModal === "xai" ? "xAI Login" : "Codex Login"}
          subtitle={props.loginModal === "xai" ? "Sign in with a SuperGrok or X Premium+ subscription" : "Sign in with a ChatGPT Plus/Pro subscription"}
          providerLabel={props.loginModal === "xai" ? "xAI" : "Codex"}
          onStartLogin={(name) => {
            const controller = new AbortController();
            const start = props.loginModal === "xai" ? startXaiLogin : startCodexLogin;
            return start({ profile: name, signal: controller.signal }).then((handle) => ({
              authorizeUrl: handle.authorizeUrl,
              completed: handle.completed,
              cancel: () => {
                controller.abort();
                handle.cancel();
              },
            }));
          }}
          autoLoginProfile={props.autoLoginProfile}
          onSwitchProfile={props.loginModal === "xai" ? props.switchToXaiProfile : props.switchToCodexProfile}
          onRemoveProfile={props.loginModal === "xai" ? props.removeXaiProfileEverywhere : props.removeCodexProfileEverywhere}
          onClose={props.onCloseLoginModal}
        />
      )}
    </>
  );
}
