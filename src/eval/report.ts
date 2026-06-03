import type { Cost, RunMetrics } from "./types.js";

function formatCost(cost: Cost): string {
  if (!cost.known || cost.usd === null) return "unknown";
  return `$${cost.usd.toFixed(4)}`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function topTools(byType: Record<string, number>, limit = 3): string {
  const entries = Object.entries(byType).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return "-";
  return entries
    .slice(0, limit)
    .map(([name, n]) => `${name}:${n}`)
    .join(" ");
}

// A side-by-side A/B table over the metrics that matter: pass/fail, turns, tool
// calls, tokens, cost, wall-clock. Variant A and B results are matched by task
// name so a missing pairing surfaces rather than silently misaligning.
export function formatReport(
  a: RunMetrics[],
  b: RunMetrics[],
  labelA = "A",
  labelB = "B",
): string {
  const byTaskB = new Map(b.map((m) => [m.task, m]));
  const lines: string[] = [];
  lines.push(`Eval A/B: ${labelA} vs ${labelB}`);
  lines.push("");

  const header = `${pad("task", 22)}${pad("metric", 12)}${pad(labelA, 16)}${pad(labelB, 16)}`;
  lines.push(header);
  lines.push("-".repeat(header.length));

  const row = (task: string, metric: string, av: string, bv: string): void => {
    lines.push(`${pad(task, 22)}${pad(metric, 12)}${pad(av, 16)}${pad(bv, 16)}`);
  };

  for (const ma of a) {
    const mb = byTaskB.get(ma.task);
    if (mb === undefined) {
      row(ma.task, "pass", ma.passed ? "yes" : "no", "(no pairing)");
      continue;
    }
    row(ma.task, "pass", ma.passed ? "yes" : "no", mb.passed ? "yes" : "no");
    row("", "turns", String(ma.turns), String(mb.turns));
    row("", "tool calls", String(ma.toolCalls), String(mb.toolCalls));
    row("", "tokens", String(ma.totalTokens), String(mb.totalTokens));
    row("", "cost", formatCost(ma.cost), formatCost(mb.cost));
    row("", "wall (s)", (ma.wallClockMs / 1000).toFixed(1), (mb.wallClockMs / 1000).toFixed(1));
    row("", "top tools", topTools(ma.toolCallsByType), topTools(mb.toolCallsByType));
    lines.push("");
  }

  // Totals: pass rate and aggregate cost (only when every counted run is priced,
  // else "unknown" so an unpriced model never inflates a $0 total).
  const passRate = (runs: RunMetrics[]): string =>
    `${runs.filter((r) => r.passed).length}/${runs.length}`;
  const totalCost = (runs: RunMetrics[]): string => {
    if (runs.some((r) => !r.cost.known)) return "unknown";
    return `$${runs.reduce((sum, r) => sum + (r.cost.usd ?? 0), 0).toFixed(4)}`;
  };
  lines.push("-".repeat(header.length));
  row("TOTAL", "pass", passRate(a), passRate(b));
  row("", "cost", totalCost(a), totalCost(b));

  return lines.join("\n");
}
