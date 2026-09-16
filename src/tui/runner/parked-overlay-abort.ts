/**
 * TUI session overlay abort slot. Approval resume registers the parked
 * overlay controller here; the permission gate's identity signal merges it
 * so a reactor approval timeout dismisses the overlay instead of leaving it
 * parked after the call is gone.
 */

interface ParkedOverlayAbortBinding {
  registerOverlayAbort: (controller: AbortController | undefined) => void;
  identitySignal: (identity: AbortSignal) => AbortSignal;
}

export function createParkedOverlayAbortBinding(): ParkedOverlayAbortBinding {
  const parkedOverlayAbort = {
    controller: undefined as AbortController | undefined,
  };
  return {
    registerOverlayAbort: (controller) => {
      parkedOverlayAbort.controller = controller;
    },
    identitySignal: (identity) => {
      const parked = parkedOverlayAbort.controller?.signal;
      return parked === undefined
        ? identity
        : AbortSignal.any([identity, parked]);
    },
  };
}
