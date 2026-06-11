import { useEffect, useState } from "react";

export type ScrollController = {
  scrollOffset: number;
  scrollUp: () => void;
  scrollDown: () => void;
  pageUp: () => void;
  pageDown: () => void;
  scrollToTop: () => void;
  scrollToBottom: () => void;
  atBottom: boolean;
};

export type UseScrollArgs = {
  renderableCount: number;
  visibleRows: number;
};

export function useScroll({ renderableCount, visibleRows }: UseScrollArgs): ScrollController {
  const [scrollOffset, setScrollOffset] = useState(0);
  const [isPinnedToBottom, setIsPinnedToBottom] = useState(true);

  const maxOffset = Math.max(0, renderableCount - 1);
  // A page jump covers most of the viewport but leaves a row of overlap so the
  // reader keeps their place across the jump. Offsets are block-indexed, so this
  // is a coarse fast-traversal step, not an exact line page — paired with the
  // single-block arrow steps it gives both quick movement and fine control.
  const pageStep = Math.max(1, visibleRows - 1);

  useEffect(() => {
    if (isPinnedToBottom) {
      setScrollOffset(maxOffset);
    }
  }, [maxOffset, isPinnedToBottom]);

  useEffect(() => {
    if (scrollOffset <= maxOffset) return;
    setScrollOffset(maxOffset);
    setIsPinnedToBottom(true);
  }, [maxOffset, scrollOffset]);

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
    pageUp: () => {
      setIsPinnedToBottom(false);
      setScrollOffset((o) => Math.max(0, o - pageStep));
    },
    pageDown: () => {
      setScrollOffset((o) => {
        const next = Math.min(maxOffset, o + pageStep);
        setIsPinnedToBottom(next >= maxOffset);
        return next;
      });
    },
    scrollToTop: () => {
      setIsPinnedToBottom(false);
      setScrollOffset(0);
    },
    scrollToBottom: () => {
      setIsPinnedToBottom(true);
      setScrollOffset(maxOffset);
    },
  };
}
