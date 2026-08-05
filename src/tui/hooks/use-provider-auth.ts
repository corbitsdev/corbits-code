import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { getLogger } from "@intx/log";
import { getValidCodexToken, CodexAuthError } from "../../auth/codex/session.js";
import { refreshCodexInstructions } from "../../auth/codex/instructions.js";
import { removeCodexProfile } from "../../auth/codex/store.js";
import { CODEX_BASE_URL, CODEX_DEFAULT_MODELS } from "../../auth/codex/constants.js";
import { getValidXaiToken, XaiAuthError } from "../../auth/xai/session.js";
import { removeXaiProfile } from "../../auth/xai/store.js";
import { XAI_BASE_URL, XAI_DEFAULT_MODELS } from "../../auth/xai/constants.js";
import { codexProviderName, codexProfileFromProviderName } from "../../config/codex-providers.js";
import { xaiProviderName, xaiProfileFromProviderName } from "../../config/xai-providers.js";
import { fetchCodexModels } from "../../auth/codex/usage.js";
import type { ProviderCatalogEntry } from "../../config/index.js";
import { LOG_NAMESPACE_ROOT } from "../../branding.js";

const logger = getLogger([LOG_NAMESPACE_ROOT, "tui", "provider-auth"]);

export type LoginModal = "codex" | "xai" | "choose" | null;

export type UseProviderAuthArgs = {
  provider: string;
  providerCatalog: ProviderCatalogEntry[];
  registerCodexProvider: (entry: ProviderCatalogEntry) => void;
  registerXaiProvider: (entry: ProviderCatalogEntry) => void;
  removeCodexProvider: (name: string) => void;
  removeXaiProvider: (name: string) => void;
  setCommandMessage: Dispatch<SetStateAction<string | null>>;
  onCredentialFailureRef: { current: () => void };
};

export type ProviderAuthController = {
  unauthedProviders: ReadonlySet<string>;
  setUnauthedProviders: Dispatch<SetStateAction<ReadonlySet<string>>>;
  loginModal: LoginModal;
  setLoginModal: Dispatch<SetStateAction<LoginModal>>;
  autoLoginProfile: string | undefined;
  setAutoLoginProfile: Dispatch<SetStateAction<string | undefined>>;
  codexProfileNames: string[];
  xaiProfileNames: string[];
  refreshAuthState: () => void;
  promptCodexRelogin: (name: string) => void;
  promptXaiRelogin: (name: string) => void;
  switchToCodexProfile: (name: string) => void;
  switchToXaiProfile: (name: string) => void;
  removeCodexProfileEverywhere: (name: string) => void;
  removeXaiProfileEverywhere: (name: string) => void;
};

export function useProviderAuth({
  provider,
  providerCatalog,
  registerCodexProvider,
  registerXaiProvider,
  removeCodexProvider,
  removeXaiProvider,
  setCommandMessage,
  onCredentialFailureRef,
}: UseProviderAuthArgs): ProviderAuthController {
  const [unauthedProviders, setUnauthedProviders] = useState<ReadonlySet<string>>(() => new Set());
  const [loginModal, setLoginModal] = useState<LoginModal>(null);
  const [autoLoginProfile, setAutoLoginProfile] = useState<string | undefined>(undefined);

  // Updated every render so the stream callback always sees the current provider.
  onCredentialFailureRef.current = () => {
    if (loginModal !== null) return;
    const xaiName = xaiProfileFromProviderName(provider);
    const codexName = codexProfileFromProviderName(provider);
    if (xaiName !== undefined) {
      void getValidXaiToken(xaiName).then(
        () => {
          // Token is locally valid but the proxy returned 403 — subscription or
          // account-level access issue, not a bad token. Re-authing won't help.
          setCommandMessage(
            `Grok 403: "${xaiName}" has a valid token but the proxy rejected the request. ` +
            `Check your SuperGrok or X Premium+ subscription at grok.com.`,
          );
        },
        (err: unknown) => {
          if (err instanceof XaiAuthError) {
            setAutoLoginProfile(xaiName);
            setLoginModal("xai");
          }
        },
      );
    } else if (codexName !== undefined) {
      // Access token rejected by the provider (or refresh already dead): open
      // the browser re-auth flow instead of leaving the user on a 401 banner.
      setAutoLoginProfile(codexName);
      setLoginModal("codex");
    } else {
      setAutoLoginProfile(undefined);
      setLoginModal("choose");
    }
  };

  const codexProfileNames = useMemo(
    () =>
      providerCatalog
        .map((p) => p.codexProfile)
        .filter((name): name is string => name !== undefined),
    [providerCatalog],
  );
  const xaiProfileNames = useMemo(
    () =>
      providerCatalog
        .map((p) => p.xaiProfile)
        .filter((name): name is string => name !== undefined),
    [providerCatalog],
  );

  // Check which OAuth providers currently have valid tokens and update the
  // unauthedProviders set. Called after login/logout and when the agent modal opens.
  const refreshAuthState = (): void => {
    const checks = providerCatalog.flatMap((p) => {
      if (p.xaiProfile !== undefined) {
        const profile = p.xaiProfile;
        const providerName = p.name;
        return [getValidXaiToken(profile).then(
          () => ({ providerName, ok: true }),
          () => ({ providerName, ok: false }),
        )];
      }
      return [];
    });
    void Promise.all(checks).then((results) => {
      const unauthed = new Set(results.filter((r) => !r.ok).map((r) => r.providerName));
      setUnauthedProviders(unauthed);
    });
  };

  // Open the OAuth re-login modal for a dead/missing profile instead of dumping
  // the raw 401. The modal's autoLoginProfile path starts the browser flow
  // immediately so the user does not have to dig through a profile list first.
  const promptCodexRelogin = (name: string): void => {
    setAutoLoginProfile(name);
    setLoginModal("codex");
  };
  const promptXaiRelogin = (name: string): void => {
    setAutoLoginProfile(name);
    setLoginModal("xai");
  };

  const switchToCodexProfile = (name: string): void => {
    void refreshCodexInstructions().catch((err: unknown) => {
      // Best-effort prompt refresh; profile switch still proceeds with cached text.
      logger.warn("Codex instructions refresh failed: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    void Promise.all([
      getValidCodexToken(name),
      fetchCodexModels(name).catch((err: unknown) => {
        // Empty catalog falls back to CODEX_DEFAULT_MODELS below; log so
        // rate-limit/network failures are visible while switching profiles.
        logger.debug("Codex models fetch failed for profile {profile}; using defaults: {error}", {
          profile: name,
          error: err instanceof Error ? err.message : String(err),
        });
        return [];
      }),
    ]).then(
      ([token, liveModels]) => {
        const accountId = token.accountId;
        // Prefer the account's live model catalog; fall back to the current
        // default set when empty (e.g. while rate-limited the catalog is empty).
        const models = liveModels.length > 0 ? liveModels : [...CODEX_DEFAULT_MODELS];
        const defaultModel = models[0] ?? CODEX_DEFAULT_MODELS[0];
        registerCodexProvider({
          name: codexProviderName(name),
          baseURL: CODEX_BASE_URL,
          apiKey: token.access,
          models,
          defaultModel,
          codexProfile: name,
          ...(accountId !== undefined ? { codexAccountId: accountId } : {}),
        });
      },
      (err: unknown) => {
        // Refresh/token missing: drop the user into the browser re-auth flow
        // rather than surfacing the provider's 401 JSON as a status line.
        if (err instanceof CodexAuthError) {
          promptCodexRelogin(name);
          return;
        }
        setCommandMessage(
          `Could not use Codex profile "${name}": ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    );
  };

  const removeCodexProfileEverywhere = (name: string): void => {
    removeCodexProvider(codexProviderName(name));
    void removeCodexProfile(name).then(
      () => setCommandMessage(`Removed Codex profile "${name}".`),
      (err: unknown) => setCommandMessage(`Failed to remove Codex profile "${name}": ${err instanceof Error ? err.message : String(err)}`),
    );
  };

  const switchToXaiProfile = (name: string): void => {
    void getValidXaiToken(name).then(
      (token) => {
        const defaultModel = XAI_DEFAULT_MODELS[0];
        registerXaiProvider({
          name: xaiProviderName(name),
          baseURL: XAI_BASE_URL,
          apiKey: token.access,
          models: [...XAI_DEFAULT_MODELS],
          defaultModel,
          xaiProfile: name,
        });
        refreshAuthState();
      },
      (err: unknown) => {
        if (err instanceof XaiAuthError) {
          promptXaiRelogin(name);
          return;
        }
        setCommandMessage(
          `Could not use xAI profile "${name}": ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    );
  };

  const removeXaiProfileEverywhere = (name: string): void => {
    removeXaiProvider(xaiProviderName(name));
    void removeXaiProfile(name).then(
      () => setCommandMessage(`Removed xAI profile "${name}".`),
      (err: unknown) => setCommandMessage(`Failed to remove xAI profile "${name}": ${err instanceof Error ? err.message : String(err)}`),
    );
  };

  return {
    unauthedProviders,
    setUnauthedProviders,
    loginModal,
    setLoginModal,
    autoLoginProfile,
    setAutoLoginProfile,
    codexProfileNames,
    xaiProfileNames,
    refreshAuthState,
    promptCodexRelogin,
    promptXaiRelogin,
    switchToCodexProfile,
    switchToXaiProfile,
    removeCodexProfileEverywhere,
    removeXaiProfileEverywhere,
  };
}
