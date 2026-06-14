import { useState, useRef } from "react";
import { parseAtState, type AtState } from "./parse.js";
import { listAtSuggestions } from "./list.js";

export type AtSuggestionsHook = {
  atState: AtState | null;
  suggestions: string[];
  selectedIdx: number;
  // Call this from useInput after every value/cursor change so the suggestion
  // list stays in sync without needing a useEffect.
  refresh: (value: string, cursor: number) => void;
  selectUp: () => void;
  selectDown: () => void;
  resetSelection: () => void;
  clear: () => void;
};

export function useAtSuggestions(cwd: string): AtSuggestionsHook {
  const [atState, setAtState] = useState<AtState | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);

  // Generation counter: each refresh increments this. The async callback only
  // applies its result if the counter hasn't moved on while it was in-flight.
  const generation = useRef(0);
  // Cache the last prefix we listed so we skip redundant fs calls on cursor-only moves.
  const lastPrefix = useRef<string | null>(null);

  const refresh = (value: string, cursor: number) => {
    const next = parseAtState(value, cursor);
    setAtState(next);

    if (next === null) {
      lastPrefix.current = null;
      setSuggestions([]);
      setSelectedIdx(0);
      return;
    }

    // Skip the fs round-trip when the prefix hasn't changed.
    if (next.prefix === lastPrefix.current) return;
    lastPrefix.current = next.prefix;

    const gen = ++generation.current;
    void listAtSuggestions(next.prefix, cwd).then((results) => {
      if (generation.current !== gen) return;
      setSuggestions(results);
      setSelectedIdx(0);
    });
  };

  const selectUp = () => setSelectedIdx((i) => Math.max(0, i - 1));
  const selectDown = () =>
    setSelectedIdx((i) => Math.min(Math.max(0, suggestions.length - 1), i + 1));
  const resetSelection = () => setSelectedIdx(0);

  const clear = () => {
    generation.current++;
    lastPrefix.current = null;
    setAtState(null);
    setSuggestions([]);
    setSelectedIdx(0);
  };

  return { atState, suggestions, selectedIdx, refresh, selectUp, selectDown, resetSelection, clear };
}
