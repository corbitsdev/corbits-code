/**
 * Background model discovery for the setup surface: Ollama's installed-model
 * list (replaces the seeded pick-list once it resolves), the Go / Zen
 * catalog prefetches, and the signed-in ChatGPT account's catalog. All
 * mutate shared state, repaint, and ignore resolutions from superseded
 * attempts.
 */

import { createOverlayList } from "../shell/overlay-list.js";
import type { CliRenderer } from "@opentui/core";
import { getLogger } from "@intx/log";
import {
  modelChoiceRows,
  modelFromRowId,
  providerListHeight,
  TYPE_MODEL_ID,
} from "./choices.js";
import { CODEX_DEFAULT_MODELS } from "../../auth/codex/constants.js";
import { startRamp, stopRamp } from "./surface.js";
import type {
  DiscoveryFlows,
  SetupSelectors,
  SetupState,
  Surface,
} from "./types.js";
import { LOG_NAMESPACE_ROOT } from "../../branding.js";
import { logCatalogFallback } from "../../provider/bounded-model-catalog.js";

const logger = getLogger([LOG_NAMESPACE_ROOT, "tui", "provider-discovery"]);

export function createDiscoveryFlows(
  state: SetupState,
  surface: Surface,
  selectors: SetupSelectors,
): DiscoveryFlows {
  const abandonOllamaDiscovery = (): void => {
    state.ollamaDiscoveryAttempt += 1;
    state.ollamaDiscoveryAbort?.abort();
    state.ollamaDiscoveryAbort = null;
  };

  const abandonGoPrefetch = (): void => {
    state.goPrefetchAttempt += 1;
  };

  const abandonZenPrefetch = (): void => {
    state.zenPrefetchAttempt += 1;
  };

  const abandonCodexPrefetch = (): void => {
    state.codexPrefetchAttempt += 1;
  };

  const beginOllamaDiscovery = (): void => {
    if (!selectors.isOllamaModelStep()) return;
    abandonOllamaDiscovery();
    const attempt = state.ollamaDiscoveryAttempt;
    const rootURL = state.values.baseURL;
    const abort = new AbortController();
    state.ollamaDiscoveryAbort = abort;
    state.ollamaDiscovery = "loading";
    stopRamp(state);
    startRamp(state, () => surface.paintStatus());
    surface.paint();
    state.discoverOllamaModels({ rootURL, signal: abort.signal }).then(
      (result) => {
        if (
          state.settled ||
          attempt !== state.ollamaDiscoveryAttempt ||
          state.values.baseURL !== rootURL ||
          !selectors.isOllamaModelStep()
        ) {
          return;
        }
        stopRamp(state);
        state.ollamaDiscoveryAbort = null;
        state.ollamaDiscovery = result;
        if (result.status === "models" && state.choice !== null) {
          state.values.model = result.models[0] ?? "";
          // Seed the catalog choice so submit persists every installed model,
          // not only the one picked on this screen.
          state.choice = {
            ...state.choice,
            models: [...result.models],
            defaultModel: state.values.model,
          };
          state.listRows = modelChoiceRows(state.choice).filter(
            (row) => row.id !== TYPE_MODEL_ID,
          );
          state.list = createOverlayList(state.renderer as CliRenderer, {
            count: state.listRows.length,
            items: providerListHeight(state.renderer),
          });
        }
        surface.paint();
      },
      (err: unknown) => {
        if (
          state.settled ||
          attempt !== state.ollamaDiscoveryAttempt ||
          state.values.baseURL !== rootURL ||
          !selectors.isOllamaModelStep()
        ) {
          return;
        }
        stopRamp(state);
        state.ollamaDiscoveryAbort = null;
        state.ollamaDiscovery = {
          status: "malformed",
          message: err instanceof Error ? err.message : String(err),
        };
        surface.paint();
      },
    );
  };

  const beginGoPrefetch = (): void => {
    if (!selectors.isGoModelListStep()) return;
    abandonGoPrefetch();
    const attempt = state.goPrefetchAttempt;
    void state
      .prefetchGoModels()
      .then((ids) => {
        if (
          state.settled ||
          attempt !== state.goPrefetchAttempt ||
          !selectors.isGoModelListStep() ||
          state.choice === null
        ) {
          return;
        }
        const listed = state.choice.models;
        const same =
          ids.length === listed.length &&
          ids.every((id, i) => id === listed[i]);
        if (same) return;
        const focusedId = state.listRows[state.list.activeIndex]?.id;
        state.choice = { ...state.choice, models: [...ids] };
        state.listRows = modelChoiceRows(state.choice);
        const found =
          focusedId === undefined
            ? -1
            : state.listRows.findIndex((row) => row.id === focusedId);
        state.list = createOverlayList(state.renderer as CliRenderer, {
          count: state.listRows.length,
          items: providerListHeight(state.renderer),
          activeIndex: found >= 0 ? found : 0,
        });
        surface.paint();
      })
      .catch((err: unknown) => {
        // Seed list is already on screen; a failed prefetch must not surface
        // modally. The now-stale seeded picker gets a non-modal receipt.
        logger.warn`model catalog prefetch failed provider=go error=${err instanceof Error ? err.message : String(err)}`;
      });
  };

  const beginZenPrefetch = (): void => {
    if (!selectors.isZenModelListStep()) return;
    abandonZenPrefetch();
    const attempt = state.zenPrefetchAttempt;
    void state
      .prefetchZenModels()
      .then((ids) => {
        if (
          state.settled ||
          attempt !== state.zenPrefetchAttempt ||
          !selectors.isZenModelListStep() ||
          state.choice === null
        ) {
          return;
        }
        const listed = state.choice.models;
        const same =
          ids.length === listed.length &&
          ids.every((id, i) => id === listed[i]);
        if (same) return;
        const focusedId = state.listRows[state.list.activeIndex]?.id;
        state.choice = { ...state.choice, models: [...ids] };
        state.listRows = modelChoiceRows(state.choice);
        const found =
          focusedId === undefined
            ? -1
            : state.listRows.findIndex((row) => row.id === focusedId);
        state.list = createOverlayList(state.renderer as CliRenderer, {
          count: state.listRows.length,
          items: providerListHeight(state.renderer),
          activeIndex: found >= 0 ? found : 0,
        });
        surface.paint();
      })
      .catch((err: unknown) => {
        // Seed list is already on screen; a failed prefetch must not surface
        // modally. The now-stale seeded picker gets a non-modal receipt.
        logger.warn`model catalog prefetch failed provider=zen error=${err instanceof Error ? err.message : String(err)}`;
      });
  };

  // Unlike Go and Zen, the list belongs to the account just signed in, so its
  // first model replaces the prefilled default as the pick unless the
  // operator has already moved to another model or to the type-a-model row.
  // A fetch that fails leaves the list on screen as it is, which is only
  // right while that list belongs to this sign-in: a different account
  // starts again from the built-in list.
  const beginCodexPrefetch = (): void => {
    if (!selectors.isCodexModelListStep()) return;
    const login = state.loginResult;
    if (login?.kind !== "codex" || state.choice === null) return;
    abandonCodexPrefetch();
    if (state.codexListLogin !== null && state.codexListLogin !== login) {
      state.codexListLogin = null;
      state.choice = {
        ...state.choice,
        models: CODEX_DEFAULT_MODELS,
        defaultModel: CODEX_DEFAULT_MODELS[0],
      };
      state.values.model = state.choice.defaultModel;
      state.listRows = modelChoiceRows(state.choice);
      state.list = createOverlayList(state.renderer as CliRenderer, {
        count: state.listRows.length,
        items: providerListHeight(state.renderer),
        activeIndex: 0,
      });
      surface.paint();
    }
    const attempt = state.codexPrefetchAttempt;
    const prefill = state.choice.defaultModel;
    void state
      .discoverCodexModels(login.tokens)
      .then((discovered) => {
        if (
          state.settled ||
          attempt !== state.codexPrefetchAttempt ||
          !selectors.isCodexModelListStep() ||
          state.choice === null
        ) {
          return;
        }
        if (discovered.status !== "models") {
          logCatalogFallback(
            "ChatGPT sign-in",
            discovered,
            "the listed models",
          );
          return;
        }
        const ids = discovered.models;
        const listed = state.choice.models;
        const same =
          ids.length === listed.length &&
          ids.every((id, i) => id === listed[i]);
        if (same) return;
        const choiceId = state.choice.id;
        const focusedId = state.listRows[state.list.activeIndex]?.id;
        const focused =
          focusedId === undefined || focusedId === TYPE_MODEL_ID
            ? undefined
            : modelFromRowId(choiceId, focusedId);
        const pick =
          focused !== undefined && focused !== prefill && ids.includes(focused)
            ? focused
            : ids[0];
        state.choice = {
          ...state.choice,
          models: [...ids],
          defaultModel: ids[0],
        };
        state.codexListLogin = login;
        state.listRows = modelChoiceRows(state.choice);
        const focusTypeRow = focusedId === TYPE_MODEL_ID;
        if (!focusTypeRow) state.values.model = pick;
        const found = state.listRows.findIndex((row) =>
          focusTypeRow
            ? row.id === TYPE_MODEL_ID
            : modelFromRowId(choiceId, row.id) === pick,
        );
        state.list = createOverlayList(state.renderer as CliRenderer, {
          count: state.listRows.length,
          items: providerListHeight(state.renderer),
          activeIndex: found >= 0 ? found : 0,
        });
        surface.paint();
      })
      .catch((err: unknown) => {
        // discoverCodexModels never rejects, so only a failure while swapping
        // the list in lands here; the list already on screen stays usable.
        logger.warn`ChatGPT sign-in model list update failed error=${err instanceof Error ? err.message : String(err)}`;
      });
  };

  return {
    beginOllamaDiscovery,
    abandonOllamaDiscovery,
    beginGoPrefetch,
    abandonGoPrefetch,
    beginZenPrefetch,
    abandonZenPrefetch,
    beginCodexPrefetch,
    abandonCodexPrefetch,
  };
}
