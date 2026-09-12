/**
 * Background model discovery for the setup surface: Ollama's installed-model
 * list (which replaces the seeded pick-list once it resolves) and the OpenCode
 * Go and Zen catalog prefetches. All mutate the shared state and repaint; all
 * ignore resolutions from superseded attempts.
 */

import { createOverlayList } from "../shell/overlay-list.js";
import type { CliRenderer } from "@opentui/core";
import {
  modelChoiceRows,
  providerListHeight,
  TYPE_MODEL_ID,
} from "./choices.js";
import { RAMP_TICK_MS, stopRamp } from "./surface.js";
import type {
  DiscoveryFlows,
  SetupSelectors,
  SetupState,
  Surface,
} from "./types.js";

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

  const beginOllamaDiscovery = (): void => {
    if (!selectors.isOllamaModelStep()) return;
    abandonOllamaDiscovery();
    const attempt = state.ollamaDiscoveryAttempt;
    const rootURL = state.values.baseURL;
    const abort = new AbortController();
    state.ollamaDiscoveryAbort = abort;
    state.ollamaDiscovery = "loading";
    stopRamp(state);
    state.rampTimer = setInterval(() => surface.paintStatus(), RAMP_TICK_MS);
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
      .catch(() => {
        // Seed list is already on screen; a failed prefetch must not surface.
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
      .catch(() => {
        // Seed list is already on screen; a failed prefetch must not surface.
      });
  };

  return {
    beginOllamaDiscovery,
    abandonOllamaDiscovery,
    beginGoPrefetch,
    abandonGoPrefetch,
    beginZenPrefetch,
    abandonZenPrefetch,
  };
}
