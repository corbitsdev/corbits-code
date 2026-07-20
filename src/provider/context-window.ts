// Approximate total context window (tokens) per model, used to render
// context-window occupancy in the status bar and to size compaction. When
// models.dev metadata is loaded at startup it takes priority; otherwise we fall
// back to conservative per-family floors, and finally a common 128k window.

const DEFAULT_CONTEXT_WINDOW = 128_000;

// Populated at startup from the models.dev pricing cache (limit.context).
// Exact model-id match wins over the family heuristics below.
let contextWindowRegistry: Record<string, number> = {};

export function setModelContextWindows(windows: Record<string, number> | undefined): void {
  contextWindowRegistry = windows ?? {};
}

function heuristicWindow(model: string): number {
  const m = model.toLowerCase();
  if (m.includes("gpt-5") || m.includes("codex")) return 400_000;
  if (m.includes("claude")) return 200_000;
  if (m.includes("gemini")) return 1_000_000;
  if (m.includes("deepseek")) return 128_000;
  if (m.includes("glm")) return 200_000;
  if (m.includes("o3") || m.includes("o4")) return 200_000;
  return DEFAULT_CONTEXT_WINDOW;
}

export function contextWindowFor(model: string): number {
  const exact = contextWindowRegistry[model];
  if (exact !== undefined) return exact;
  return heuristicWindow(model);
}

// Fraction of the window at which proactive compaction should fire. Kept well
// below the hard limit so summarization happens while the model still reasons
// well and before any provider rejects the request.
const COMPACTION_WINDOW_FRACTION = 0.6;

// Token threshold at which the director should compact, sized to the model's
// real window. `model` may be undefined early in a session (no cycle yet); we
// fall back to the default window in that case.
export function compactionThresholdFor(model: string | undefined): number {
  const window = model !== undefined ? contextWindowFor(model) : DEFAULT_CONTEXT_WINDOW;
  return Math.floor(window * COMPACTION_WINDOW_FRACTION);
}
