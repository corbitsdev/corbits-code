// Approximate total context window (tokens) per model family, used to render
// context-window occupancy in the status bar. Values are conservative floors;
// when a model is unknown we assume a common 128k window.

const DEFAULT_CONTEXT_WINDOW = 128_000;

export function contextWindowFor(model: string): number {
  const m = model.toLowerCase();
  if (m.includes("gpt-5") || m.includes("codex")) return 400_000;
  if (m.includes("claude")) return 200_000;
  if (m.includes("gemini")) return 1_000_000;
  if (m.includes("deepseek")) return 128_000;
  if (m.includes("o3") || m.includes("o4")) return 200_000;
  return DEFAULT_CONTEXT_WINDOW;
}

const CONTEXT_DISPLAY_THRESHOLD = 0.6;

export function formatContextUsage(usedTokens: number, model: string): string | undefined {
  const window = contextWindowFor(model);
  if (usedTokens / window <= CONTEXT_DISPLAY_THRESHOLD) return undefined;
  return `Context: ${String(usedTokens)}/${String(window)}`;
}
