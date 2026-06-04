import type { Cost, JudgeScores, RunMetrics } from "./types.js";

function formatCost(cost: Cost): string {
  if (cost.flatFee === true) return "flat-fee";
  if (!cost.known || cost.usd === null) return "unknown";
  return `$${cost.usd.toFixed(4)}`;
}

// Compact judge line: correctness/scope/quality/overall, or "-" if not judged.
function formatJudge(judge: JudgeScores | null): string {
  if (judge === null) return "-";
  return `${judge.correctness}/${judge.scope}/${judge.quality}/${judge.overall}`;
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
  lines.push("judge = correctness/scope/quality/overall (1-5 each)");
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
    row("", "clean run", ma.completedCleanly ? "yes" : "no", mb.completedCleanly ? "yes" : "no");
    row("", "turns", String(ma.turns), String(mb.turns));
    row("", "tool calls", String(ma.toolCalls), String(mb.toolCalls));
    row("", "tokens", String(ma.totalTokens), String(mb.totalTokens));
    row("", "cost", formatCost(ma.cost), formatCost(mb.cost));
    row("", "wall (s)", (ma.wallClockMs / 1000).toFixed(1), (mb.wallClockMs / 1000).toFixed(1));
    row("", "top tools", topTools(ma.toolCallsByType), topTools(mb.toolCallsByType));
    // Judge scores (correctness/scope/quality/overall) only when at least one
    // side was judged.
    if (ma.judge !== null || mb.judge !== null) {
      row("", "judge", formatJudge(ma.judge), formatJudge(mb.judge));
    }
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
  // Mean overall judge score across judged tasks, with the judged-count so a
  // mean over 1-of-5 isn't mistaken for one over 5-of-5 (nulls are dropped, so
  // the count guards against parse-survivorship bias).
  const avgOverall = (runs: RunMetrics[]): string => {
    const judged = runs.map((r) => r.judge).filter((j): j is JudgeScores => j !== null);
    if (judged.length === 0) return "-";
    const mean = judged.reduce((sum, j) => sum + j.overall, 0) / judged.length;
    return `${mean.toFixed(1)} (${judged.length}/${runs.length})`;
  };
  lines.push("-".repeat(header.length));
  row("TOTAL", "pass", passRate(a), passRate(b));
  row("", "cost", totalCost(a), totalCost(b));
  row("", "judge ovr", avgOverall(a), avgOverall(b));

  return lines.join("\n");
}
