import { useState, useRef } from "react";
import { parseAtState, type AtState } from "./parse.js";
import { listPathSuggestions } from "./list.js";

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

  // Shared async helper: fetch entries for a given prefix and apply results if
  // the generation still matches.
  const fetchFor = (prefix: string, gen: number) => {
    void listPathSuggestions(prefix, cwd).then((results) => {
      if (generation.current !== gen) return;
      setSuggestions(results);
      setSelectedIdx(0);
    });
  };

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
    fetchFor(next.prefix, gen);
  };

  // Navigate up. When already at idx=0 and inside a subpath, ascend to the
  // parent directory. Side effects run in the function body, not inside a
  // state updater, so they execute exactly once per call.
  const selectUp = () => {
    if (selectedIdx > 0) {
      setSelectedIdx(selectedIdx - 1);
      return;
    }
    if (lastPrefix.current !== null && lastPrefix.current !== "") {
      const p = lastPrefix.current;
      const stripped = p.endsWith("/") ? p.slice(0, -1) : p;
      const lastSlash = stripped.lastIndexOf("/");
      const parent = lastSlash === -1 ? "" : stripped.slice(0, lastSlash + 1);
      if (parent !== lastPrefix.current) {
        lastPrefix.current = parent;
        setAtState((s) => s !== null ? { ...s, prefix: parent } : s);
        const gen = ++generation.current;
        fetchFor(parent, gen);
        setSelectedIdx(0);
      }
    }
  };

  // Navigate down. When already at the last entry and it is a directory,
  // auto-enter it. Reads suggestions from the current render closure — correct
  // because this is called synchronously from useInput.
  const selectDown = () => {
    const last = Math.max(0, suggestions.length - 1);
    if (selectedIdx < last) {
      setSelectedIdx(selectedIdx + 1);
      return;
    }
    const sel = suggestions[selectedIdx];
    if (sel !== undefined && sel.endsWith("/")) {
      lastPrefix.current = sel;
      setAtState((s) => s !== null ? { ...s, prefix: sel } : s);
      const gen = ++generation.current;
      fetchFor(sel, gen);
      setSelectedIdx(0);
    }
  };

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
