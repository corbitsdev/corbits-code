import { Box, Text } from "ink";
import {
  goalCriteriaProgress,
  type GoalCriterion,
  type GoalCriterionStatus,
  type GoalPhase,
  type GoalSnapshot,
  type GoalStatus,
} from "../../agent/goal.js";
import { color } from "../theme.js";

export type GoalViewProps = {
  goal: GoalSnapshot;
  /** When true, show only brief + phase strip (implementing phase). */
  compact?: boolean;
};

const GLYPH: Record<GoalCriterionStatus, string> = {
  todo: "○",
  doing: "●",
  done: "✓",
  blocked: "!",
  cancelled: "✗",
};

/** Compact phase labels for narrow TUI chrome (full words in /status). */
const PHASE_SHORT: Record<GoalPhase, string> = {
  planning: "plan",
  implementing: "impl",
  reviewing: "review",
  completed: "done",
};

const PHASE_ORDER: readonly GoalPhase[] = [
  "planning",
  "implementing",
  "reviewing",
  "completed",
];

/**
 * Expanded acceptance checklist — primary goal surface.
 * Quiet styling (muted labels, no bright accent wash).
 */
export function GoalView({ goal, compact }: GoalViewProps) {
  if (goal.status === "inactive" || goal.status === "cleared") return null;

  const phase = goal.phase;
  const progress = goalCriteriaProgress(goal.criteria);
  const brief = goal.brief || goal.condition;
  const quiet = isQuietStatus(goal.status);

  if (compact || goal.criteria.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box gap={1}>
          <Text bold color={color("muted")}>
            Goal
          </Text>
          <PhaseTrail phase={phase} />
          {!quiet && (
            <Text color={statusColor(goal.status)} dimColor={quiet}>
              {goal.status}
            </Text>
          )}
        </Box>
        <Text wrap="truncate-end" dimColor={quiet}>
          {brief}
        </Text>
        {goal.criteria.length === 0 && phase === "planning" && (
          <Text color={color("dim")} dimColor>
            planning acceptance…
          </Text>
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box gap={1}>
        <Text bold color={color("muted")}>
          Acceptance
        </Text>
        <PhaseTrail phase={phase} />
        <Text color={color("dim")} dimColor>
          {`${progress.done}/${progress.total}`}
        </Text>
        {!quiet && (
          <Text color={statusColor(goal.status)} dimColor={quiet}>
            {goal.status}
          </Text>
        )}
      </Box>
      <Text wrap="truncate-end" color={color("dim")} dimColor>
        {brief}
      </Text>
      {sortedCriteria(goal.criteria).map((c) => (
        <Box key={c.id} gap={1}>
          <Text color={criterionColor(c.status)}>{GLYPH[c.status]}</Text>
          <Text
            {...(c.status === "done" || c.status === "cancelled"
              ? { color: color("dim"), strikethrough: true }
              : {})}
            bold={c.status === "doing"}
            wrap="truncate-end"
          >
            {c.title}
          </Text>
          {c.note !== undefined && c.note.length > 0 && (
            <Text color={color("dim")} dimColor wrap="truncate-end">
              {c.note}
            </Text>
          )}
        </Box>
      ))}
      {goal.lastReason !== undefined && goal.lastReason.length > 0 && (
        <Text color={color("dim")} dimColor wrap="truncate-end">
          {goal.lastReason}
        </Text>
      )}
    </Box>
  );
}

/** plan → impl → review → done with current phase emphasized. */
function PhaseTrail({ phase }: { phase: GoalPhase }) {
  const idx = PHASE_ORDER.indexOf(phase);
  return (
    <Box gap={0}>
      {PHASE_ORDER.map((p, i) => {
        const current = p === phase;
        return (
          <Box key={p} gap={0}>
            {i > 0 && (
              <Text color={color("dim")} dimColor>
                →
              </Text>
            )}
            <Text
              bold={current}
              color={current ? color("text") : color("dim")}
              dimColor={!current || i < idx}
            >
              {PHASE_SHORT[p]}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

function sortedCriteria(criteria: GoalCriterion[]): GoalCriterion[] {
  const rank: Record<GoalCriterionStatus, number> = {
    doing: 0,
    blocked: 1,
    todo: 2,
    done: 3,
    cancelled: 4,
  };
  return [...criteria].sort((a, b) => rank[a.status] - rank[b.status]);
}

function isQuietStatus(status: GoalStatus): boolean {
  return status === "active" || status === "paused";
}

function statusColor(status: GoalStatus): string {
  switch (status) {
    case "achieved":
      return color("success");
    case "budget_limited":
    case "blocked":
      return color("warning");
    case "paused":
      return color("muted");
    case "active":
      return color("muted");
    case "cleared":
    case "inactive":
      return color("dim");
  }
}

function criterionColor(status: GoalCriterionStatus): string {
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
