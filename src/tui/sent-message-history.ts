// Per-conversation sent-message recall in the prompt (readline-style).

export type SentHistoryBrowse = {
  /** Messages sent in this session, oldest first. */
  sent: readonly string[];
  /** Unsent draft saved when the user first presses Up from live editing. */
  draft: string | null;
  /**
   * null = live (show draft or free edit).
   * 0 = newest sent, higher = older (`sent[sent.length - 1 - browseIndex]`).
   */
  browseIndex: number | null;
};

export function createSentHistoryBrowse(sent: readonly string[]): SentHistoryBrowse {
  return { sent, draft: null, browseIndex: null };
}

export function resetSentHistoryBrowse(sent: readonly string[]): SentHistoryBrowse {
  return createSentHistoryBrowse(sent);
}

export type HistoryStepResult = {
  browse: SentHistoryBrowse;
  value: string;
  cursor: number;
};

/** Up at prompt cursor 0: older sent message, or stash draft on first step. */
export function stepSentHistoryUp(
  browse: SentHistoryBrowse,
  currentValue: string,
): HistoryStepResult | null {
  if (browse.sent.length === 0) return null;

  if (browse.browseIndex === null) {
    const next: SentHistoryBrowse = {
      sent: browse.sent,
      draft: currentValue,
      browseIndex: 0,
    };
    const value = browse.sent[browse.sent.length - 1]!;
    return { browse: next, value, cursor: value.length };
  }

  const maxIndex = browse.sent.length - 1;
  if (browse.browseIndex >= maxIndex) return null;

  const next: SentHistoryBrowse = {
    ...browse,
    browseIndex: browse.browseIndex + 1,
  };
  const value = browse.sent[browse.sent.length - 1 - next.browseIndex]!;
  return { browse: next, value, cursor: value.length };
}

/** Down at prompt end: newer sent message, then draft, then live empty. */
export function stepSentHistoryDown(
  browse: SentHistoryBrowse,
  currentValue: string,
  cursor: number,
): HistoryStepResult | null {
  if (cursor !== currentValue.length) return null;
  if (browse.browseIndex === null) return null;

  if (browse.browseIndex > 0) {
    const next: SentHistoryBrowse = { ...browse, browseIndex: browse.browseIndex - 1 };
    const value = browse.sent[browse.sent.length - 1 - next.browseIndex]!;
    return { browse: next, value, cursor: value.length };
  }

  const next: SentHistoryBrowse = { ...browse, browseIndex: null };
  const value = browse.draft ?? "";
  return { browse: next, value, cursor: value.length };
}

/** Any edit while browsing returns to live mode and clears the draft slot. */
export function sentHistoryOnEdit(browse: SentHistoryBrowse): SentHistoryBrowse {
  if (browse.browseIndex === null) return browse;
  return { sent: browse.sent, draft: null, browseIndex: null };
}