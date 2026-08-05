import { Box, Text } from "ink";
import {
  formatGoalCompleted,
  goalCriteriaProgress,
  type GoalCriterion,
  type GoalCriterionStatus,
  type GoalPhase,
  type GoalSnapshot,
  type GoalStatus,
} from "../../agent/goal.js";
import { color } from "../theme.js";
import { useTerminalSize } from "../hooks/use-terminal-size.js";

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

/** Full trail `plan→impl→review→done` needs ~23 cols; below this show current only. */
const PHASE_TRAIL_MIN_COLS = 48;

/**
 * Expanded acceptance checklist — primary goal surface.
 * Quiet styling (muted labels, no bright accent wash).
 * On achieve: freezes on "Goal completed in …" and stops looking like work-in-progress.
 * Width-constrained so long briefs/criteria truncate instead of colliding with Work/footer.
 */
export function GoalView({ goal, compact }: GoalViewProps) {
  if (goal.status === "inactive" || goal.status === "cleared") return null;

  const { columns } = useTerminalSize();
  const phase = goal.phase;
  const progress = goalCriteriaProgress(goal.criteria);
  const brief = goal.brief || goal.condition;
  const quiet = isQuietStatus(goal.status);
  const completed = formatGoalCompleted(goal);
  const narrow = columns < PHASE_TRAIL_MIN_COLS;

  if (completed !== null) {
    return (
      <Box flexDirection="column" width="100%" paddingX={1} overflow="hidden">
        <Box width="100%" gap={1} overflow="hidden">
          <Box flexShrink={0}>
            <Text bold color={color("success")}>
              Goal
            </Text>
          </Box>
          <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
            <Text color={color("success")} wrap="truncate-end">
              {completed}
            </Text>
          </Box>
          {progress.total > 0 && (
            <Box flexShrink={0}>
              <Text color={color("dim")} dimColor>
                {`${progress.done}/${progress.total}`}
              </Text>
            </Box>
          )}
        </Box>
        <BriefLine brief={brief} dim />
        {goal.criteria.length > 0 &&
          sortedCriteria(goal.criteria).map((c) => <CriterionRow key={c.id} criterion={c} />)}
      </Box>
    );
  }

  if (compact || goal.criteria.length === 0) {
    return (
      <Box flexDirection="column" width="100%" paddingX={1} overflow="hidden">
        <HeaderRow
          label="Goal"
          phase={phase}
          narrow={narrow}
          progress={null}
          status={!quiet ? goal.status : null}
          quiet={quiet}
        />
        <BriefLine brief={brief} dim={quiet} />
        {goal.criteria.length === 0 && phase === "planning" && (
          <Text color={color("dim")} dimColor>
            planning acceptance…
          </Text>
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width="100%" paddingX={1} overflow="hidden">
      <HeaderRow
        label="Acceptance"
        phase={phase}
        narrow={narrow}
        progress={progress.total > 0 ? `${progress.done}/${progress.total}` : null}
        status={!quiet ? goal.status : null}
        quiet={quiet}
      />
      <BriefLine brief={brief} dim />
      {sortedCriteria(goal.criteria).map((c) => (
        <CriterionRow key={c.id} criterion={c} />
      ))}
      {goal.lastReason !== undefined && goal.lastReason.length > 0 && (
        <Box width="100%" overflow="hidden">
          <Text color={color("dim")} dimColor wrap="truncate-end">
            {goal.lastReason}
          </Text>
        </Box>
      )}
    </Box>
  );
}

function HeaderRow(props: {
  label: string;
  phase: GoalPhase;
  narrow: boolean;
  progress: string | null;
  status: GoalStatus | null;
  quiet: boolean;
}) {
  const { label, phase, narrow, progress, status, quiet } = props;
  return (
    <Box width="100%" gap={1} overflow="hidden">
      <Box flexShrink={0}>
        <Text bold color={color("muted")}>
          {label}
        </Text>
      </Box>
      <Box flexShrink={0}>
        <PhaseTrail phase={phase} narrow={narrow} />
      </Box>
      {progress !== null && (
        <Box flexShrink={0}>
          <Text color={color("dim")} dimColor>
            {progress}
          </Text>
        </Box>
      )}
      {status !== null && (
        <Box flexShrink={1} minWidth={0} overflow="hidden">
          <Text color={statusColor(status)} dimColor={quiet} wrap="truncate-end">
            {status}
          </Text>
        </Box>
      )}
    </Box>
  );
}

function BriefLine({ brief, dim }: { brief: string; dim?: boolean }) {
  return (
    <Box width="100%" overflow="hidden">
      {dim ? (
        <Text wrap="truncate-end" color={color("dim")} dimColor>
          {brief}
        </Text>
      ) : (
        <Text wrap="truncate-end">{brief}</Text>
      )}
    </Box>
  );
}

function CriterionRow({ criterion: c }: { criterion: GoalCriterion }) {
  const terminal = c.status === "done" || c.status === "cancelled";
  return (
    <Box width="100%" gap={1} overflow="hidden">
      <Box flexShrink={0}>
        <Text color={criterionColor(c.status)}>{GLYPH[c.status]}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
        <Text
          {...(terminal ? { color: color("dim"), strikethrough: true } : {})}
          bold={c.status === "doing"}
          wrap="truncate-end"
        >
          {c.title}
        </Text>
      </Box>
      {c.note !== undefined && c.note.length > 0 && (
        <Box flexShrink={1} minWidth={0} overflow="hidden">
          <Text color={color("dim")} dimColor wrap="truncate-end">
            {c.note}
          </Text>
        </Box>
      )}
    </Box>
  );
}

/** plan → impl → review → done; on narrow terminals show only the current phase. */
function PhaseTrail({ phase, narrow }: { phase: GoalPhase; narrow: boolean }) {
  if (narrow) {
    return (
      <Text bold color={color("text")}>
        {PHASE_SHORT[phase]}
      </Text>
    );
  }
  const idx = PHASE_ORDER.indexOf(phase);
  return (
    <Text>
      {PHASE_ORDER.map((p, i) => {
        const current = p === phase;
        const sep = i > 0 ? "→" : "";
        return (
          <Text
            key={p}
            bold={current}
            color={current ? color("text") : color("dim")}
            dimColor={!current || i < idx}
          >
            {sep}
            {PHASE_SHORT[p]}
          </Text>
        );
      })}
    </Text>
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
