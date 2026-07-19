import { Box, Text } from "ink";
import type { GoalCriterion, GoalCriterionStatus, GoalSnapshot } from "../../agent/goal.js";
import { goalCriteriaProgress } from "../../agent/goal.js";
import { color } from "../theme.js";

export type GoalViewProps = {
  goal: GoalSnapshot;
  /**
   * Compact: one line for current open criterion.
   * Default (expanded): full acceptance checklist — preferred while a goal is active.
   */
  compact?: boolean;
};

const GLYPH: Record<GoalCriterionStatus, string> = {
  todo: "○",
  doing: "●",
  done: "✓",
  blocked: "!",
  cancelled: "✗",
};

function statusColor(status: GoalCriterionStatus): string {
  switch (status) {
    case "done":
      return color("success");
    case "doing":
      return color("text");
    case "blocked":
      return color("warning");
    case "cancelled":
      return color("danger");
    case "todo":
      return color("muted");
  }
}

function byPriority(a: GoalCriterion, b: GoalCriterion): number {
  const rank: Record<GoalCriterionStatus, number> = {
    doing: 0,
    blocked: 1,
    todo: 2,
    cancelled: 3,
    done: 4,
  };
  return rank[a.status] - rank[b.status];
}

/** Chrome for the panel label — muted, success only when achieved. */
function labelColor(status: GoalSnapshot["status"]): string {
  if (status === "achieved") return color("success");
  if (status === "blocked" || status === "budget_limited") return color("warning");
  return color("muted");
}

/**
 * Session goal acceptance checklist.
 * This is *what done means* — not the work plan (that is Tasks / manage_tasks).
 */
export function GoalView({ goal, compact = false }: GoalViewProps) {
  if (goal.status === "inactive" || goal.status === "cleared") return null;

  const progress = goalCriteriaProgress(goal.criteria);
  const sorted = [...goal.criteria].sort(byPriority);

  if (goal.criteria.length === 0) {
    return (
      <Box paddingX={1} flexDirection="column">
        <Box gap={1}>
          <Text bold color={labelColor(goal.status)}>
            Acceptance
          </Text>
          <Text color={color("dim")} dimColor>
            planning…
          </Text>
        </Box>
        <Text color={color("muted")} dimColor wrap="truncate-end">
          {goal.brief || goal.condition}
        </Text>
      </Box>
    );
  }

  if (compact) {
    const open = sorted.filter(
      (c) => c.status === "todo" || c.status === "doing" || c.status === "blocked",
    );
    const current = open.find((c) => c.status === "doing") ?? open[0];
    if (current === undefined) {
      return (
        <Box paddingX={1} gap={1}>
          <Text color={color("success")}>✓</Text>
          <Text wrap="truncate-end">
            Acceptance {progress.done}/{progress.total}
          </Text>
          {goal.status !== "active" && goal.status !== "achieved" && (
            <Text color={color("dim")} dimColor>
              {goal.status}
            </Text>
          )}
        </Box>
      );
    }
    const remaining = open.length - 1;
    return (
      <Box paddingX={1} gap={1}>
        <Text color={statusColor(current.status)}>{GLYPH[current.status]}</Text>
        <Text wrap="truncate-end">{current.title}</Text>
        <Text color={color("dim")} dimColor>
          {progress.done}/{progress.total}
          {remaining > 0 ? ` +${remaining}` : ""}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box gap={1}>
        <Text bold color={labelColor(goal.status)}>
          Acceptance
        </Text>
        <Text color={color("dim")} dimColor>
          {progress.done}/{progress.total}
        </Text>
        {goal.status !== "active" && (
          <Text color={color("dim")} dimColor>
            {goal.status}
          </Text>
        )}
      </Box>
      {sorted.map((c) => (
        <Box key={c.id} gap={1}>
          <Text color={statusColor(c.status)}>{GLYPH[c.status]}</Text>
          <Text
            {...(c.status === "done" ? { color: color("dim"), strikethrough: true } : {})}
            bold={c.status === "doing"}
            wrap="truncate-end"
          >
            {c.title}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
