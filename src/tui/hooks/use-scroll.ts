import { useEffect, useState } from "react";

export type ScrollController = {
  scrollOffset: number;
  scrollUp: () => void;
  scrollDown: () => void;
  atBottom: boolean;
};

export type UseScrollArgs = {
  renderableCount: number;
  visibleRows: number;
};

export function useScroll({ renderableCount, visibleRows }: UseScrollArgs): ScrollController {
  const [scrollOffset, setScrollOffset] = useState(0);
  const [isPinnedToBottom, setIsPinnedToBottom] = useState(true);

  const maxOffset = Math.max(0, renderableCount - visibleRows);

  useEffect(() => {
    if (isPinnedToBottom) {
      setScrollOffset(maxOffset);
    }
  }, [maxOffset, isPinnedToBottom]);

  return {
    scrollOffset,
    atBottom: isPinnedToBottom,
    scrollUp: () => {
      setIsPinnedToBottom(false);
      setScrollOffset((o) => Math.max(0, o - 1));
    },
    scrollDown: () => {
      setScrollOffset((o) => {
        const next = Math.min(maxOffset, o + 1);
        setIsPinnedToBottom(next >= maxOffset);
        return next;
      });
    },
  };
}
