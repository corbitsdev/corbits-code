import { Box, Text } from "ink";
import {
  GOAL_PHASES,
  deriveGoalPhase,
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

/**
 * Expanded acceptance checklist — primary goal surface.
 * Quiet styling (muted labels, no bright accent wash).
 */
export function GoalView({ goal, compact }: GoalViewProps) {
  const snapshot = goal;
  if (snapshot.status === "inactive" || snapshot.status === "cleared") return null;

  const phase = snapshot.phase ?? deriveGoalPhase(snapshot.criteria, snapshot.status);
  const progress = goalCriteriaProgress(snapshot.criteria);
  const brief = snapshot.brief || snapshot.condition;
  const quiet = isQuietStatus(snapshot.status);

  if (compact || snapshot.criteria.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box gap={1}>
          <Text bold color={color("muted")}>
            Goal
          </Text>
          <PhaseTrail phase={phase} />
          {!quiet && (
            <Text color={statusColor(snapshot.status)} dimColor={quiet}>
              {snapshot.status}
            </Text>
          )}
        </Box>
        <Text wrap="truncate-end" dimColor={quiet}>
          {brief}
        </Text>
        {snapshot.criteria.length === 0 && phase === "planning" && (
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
          <Text color={statusColor(snapshot.status)} dimColor={quiet}>
            {snapshot.status}
          </Text>
        )}
      </Box>
      <Text wrap="truncate-end" color={color("dim")} dimColor>
        {brief}
      </Text>
      {sortedCriteria(snapshot.criteria).map((c) => (
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
      {snapshot.lastReason !== undefined && snapshot.lastReason.length > 0 && (
        <Text color={color("dim")} dimColor wrap="truncate-end">
          {snapshot.lastReason}
        </Text>
      )}
    </Box>
  );
}

/** planning → implementing → reviewing → completed with current phase emphasized. */
function PhaseTrail({ phase }: { phase: GoalPhase }) {
  return (
    <Box gap={0}>
      {GOAL_PHASES.map((p, i) => {
        const current = p === phase;
        const past = GOAL_PHASES.indexOf(phase) > i;
        return (
          <Box key={p} gap={0}>
            {i > 0 && (
              <Text color={color("dim")} dimColor>
                {" → "}
              </Text>
            )}
            <Text
              bold={current}
              color={current ? color("text") : color("dim")}
              dimColor={!current}
              {...(past && !current ? { strikethrough: false } : {})}
            >
              {p}
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
