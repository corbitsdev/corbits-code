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

export function useScroll({ maxOffset }: UseScrollArgs): ScrollController {
  const [storedOffset, setStoredOffset] = useState(0);
  const [pinnedToBottom, setPinnedToBottom] = useState(true);

  const scrollOffset = pinnedToBottom ? maxOffset : Math.min(storedOffset, maxOffset);
  const atBottom = pinnedToBottom || scrollOffset >= maxOffset;

  return {
    scrollOffset,
    atBottom,
    scrollUp: (by = 1) => {
      setPinnedToBottom(false);
      setStoredOffset(Math.max(0, scrollOffset - by));
    },
    scrollDown: (by = 1) => {
      const next = Math.min(maxOffset, scrollOffset + by);
      setPinnedToBottom(next >= maxOffset);
      setStoredOffset(next);
    },
    scrollToBottom: () => {
      setPinnedToBottom(true);
    },
  };
}
