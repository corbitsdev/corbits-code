import { useState } from "react";

export type ScrollController = {
  scrollOffset: number;
  scrollUp: (by?: number) => void;
  scrollDown: (by?: number) => void;
  scrollToBottom: () => void;
  atBottom: boolean;
};

export type UseScrollArgs = {
  maxOffset: number;
};

type ScrollState = {
  storedOffset: number;
  pinnedToBottom: boolean;
};

export function useScroll({ maxOffset }: UseScrollArgs): ScrollController {
  const [state, setState] = useState<ScrollState>({ storedOffset: 0, pinnedToBottom: true });

  const scrollOffset = state.pinnedToBottom ? maxOffset : Math.min(state.storedOffset, maxOffset);
  const atBottom = state.pinnedToBottom || scrollOffset >= maxOffset;

  return {
    scrollOffset,
    atBottom,
    scrollUp: (by = 1) => {
      const next = Math.max(0, scrollOffset - by);
      setState({ storedOffset: next, pinnedToBottom: false });
    },
    scrollDown: (by = 1) => {
      const next = Math.min(maxOffset, scrollOffset + by);
      setState({ storedOffset: next, pinnedToBottom: next >= maxOffset });
    },
    scrollToBottom: () => {
      setState((prev) => prev.pinnedToBottom ? prev : { ...prev, pinnedToBottom: true });
    },
  };
}
