import { useState } from "react";

export type ScrollController = {
  scrollOffset: number;
  scrollUp: () => void;
  scrollDown: () => void;
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
    scrollUp: () => {
      setPinnedToBottom(false);
      setStoredOffset(Math.max(0, scrollOffset - 1));
    },
    scrollDown: () => {
      const next = Math.min(maxOffset, scrollOffset + 1);
      setPinnedToBottom(next >= maxOffset);
      setStoredOffset(next);
    },
  };
}
