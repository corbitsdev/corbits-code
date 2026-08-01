import { Box, Text, useInput } from "ink";
import type { ReactNode } from "react";
import { useState } from "react";
import type { ApprovalOutcome, ApprovalScope, GrantScope, PermissionRequest } from "../../permission/types.js";
import { color } from "../theme.js";
import { describeToolCall } from "../tool-formatter.js";
import { stripTerminalControlSequences } from "../../util/control-char-strip.js";
import { isShellCommentOnly } from "../../permission/command.js";
import { collapseSegmentPayloads, groupChainSegmentsForDisplay, middleEllipsis } from "../command-display.js";
import type { QueuedApprovalSummary } from "../hooks/use-gates.js";

// Bidi controls (RLO, embeddings, isolates) visually reorder the rendered
// command — Trojan Source — and zero-width characters hide payload boundaries,
// so a spoofed command can read as harmless in a security prompt.
const BIDI_AND_ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

// Display-only caps: a model-authored command can be arbitrarily long or have
// thousands of chain segments, which would push the Reject/Accept choices off
// screen (and stall layout). The executed and persisted command is never
// touched — only what the modal draws.
const MAX_RENDERED_SEGMENTS = 12;
const MAX_RENDERED_LINES = 12;
const MAX_DISPLAY_LINE_LENGTH = 240;

function clampForDisplay(text: string): string {
  return text.length > MAX_DISPLAY_LINE_LENGTH
    ? `${text.slice(0, MAX_DISPLAY_LINE_LENGTH)} … truncated`
    : text;
}

// The approval subject is model-authored. Raw control bytes (\r, cursor moves,
// line erases) could repaint the modal into showing a different command than
// the one that will run, so strip them and render any surviving line break as
// a visible marker instead of a real terminal line.
function sanitizeForPrompt(text: string): string {
  return stripTerminalControlSequences(text)
    .replace(BIDI_AND_ZERO_WIDTH, "")
    .replace(/\r\n|\r|\n/g, "↵");
}

// Hints (and, more rarely, labels) for persistent Allow options share a long
// command prefix and differ only in a trailing grant note or pattern
// suffix — tail-truncation clips exactly the part that distinguishes them.
// Middle-ellipsis keeps both ends visible instead.
const CHOICE_TEXT_MAX = 64;

function truncateChoiceText(text: string, width: number): string {
  const budget = Math.max(20, Math.min(CHOICE_TEXT_MAX, width - 24));
  return middleEllipsis(text, budget);
}

// Deterministic color per agent label so queued approvals from different
// sub-agents read as visually distinct without a shared color registry.
const AGENT_TAG_ROLES = ["accent", "success", "warning", "syntaxKeyword", "syntaxFunction", "syntaxType"] as const;

function agentTagColor(label: string): string {
  let hash = 0;
  for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  return color(AGENT_TAG_ROLES[hash % AGENT_TAG_ROLES.length]!);
}

const MAX_RENDERED_QUEUE_ENTRIES = 5;

export type PermissionModalProps = {
  request: PermissionRequest;
  /** Permission gates still queued, including this modal. */
  permissionQueueDepth?: number;
  /** Summary of every queued permission request, for the "queued behind" list. */
  queuedApprovals?: readonly QueuedApprovalSummary[];
  /**
   * When set (goal mode), show that the request auto-skips after this many ms
   * if the operator does not answer.
   */
  goalTimeoutMs?: number | null;
  onResolve: (outcome: ApprovalOutcome) => void;
  width?: number;
};


// `command` choices show their hint in [] with dim styling (shell patterns/paths).
// `note` choices show their hint in () with muted styling.
// `messageable` choices activate inline message input when the user starts typing.
type Choice = {
  label: string;
  hint: string;
  hintStyle: "command" | "note";
  messageable: boolean;
  outcome: ApprovalOutcome;
};

const PERSISTENT_GRANTS: { grant: GrantScope; note: string }[] = [
  { grant: "session", note: "this session" },
  { grant: "project", note: "persisted per repo" },
  { grant: "global", note: "all projects" },
];

// When every segment of a multi-command chain shares the same leading word
// (e.g. all "git"), name the family after it; otherwise fall back to "shell"
// rather than guessing. Display only — never affects what gets granted.
function commandFamilyLabel(segments: readonly string[]): string {
  const firstWords = segments.map((s) => s.trim().split(/\s+/)[0] ?? "");
  const first = firstWords[0];
  const allSame = first !== undefined && first.length > 0 && firstWords.every((w) => w === first);
  return allSame ? first : "shell";
}

// The single concise noun phrase an "Allow" option grants — a backtick-quoted
// pattern for a single command, or "these N <family> commands" for a
// multi-segment chain grant. Never a duplicated ellipsized command mash.
function grantSubject(request: PermissionRequest, hint: string): string {
  if (request.tool !== "run_shell") return `\`${hint}\``;
  const segments = groupChainSegmentsForDisplay(request.subject).filter(
    (s) => !isShellCommentOnly(s),
  );
  if (segments.length <= 1) return `\`${hint}\``;
  const family = commandFamilyLabel(segments);
  return `these ${segments.length} ${family} commands`;
}

function buildChoices(request: PermissionRequest): Choice[] {
  const choices: Choice[] = [
    {
      label: "Reject",
      hint: "start typing to add a message",
      hintStyle: "note",
      messageable: true,
      outcome: { allow: false },
    },
    {
      label: "Accept once",
      hint: "this call only · start typing to add a message",
      hintStyle: "note",
      messageable: true,
      outcome: { allow: true },
    },
  ];

  // If a prefix scope exists (e.g. "git branch *"), offer session / project / global
  // for the wildcard pattern. This is the primary persistent path — three choices
  // that cover the whole command family without repeated prompts.
  const exactPattern = request.subject;
  const prefixScope = request.scopes.find(
    (s) => s.pattern !== null && s.pattern !== exactPattern && s.pattern.endsWith("*"),
  );
  if (prefixScope?.pattern) {
    const broadPattern = prefixScope.pattern;
    const broadHint = prefixScope.hint ?? broadPattern;
    const subject = grantSubject(request, broadHint);
    for (const option of PERSISTENT_GRANTS) {
      choices.push({
        label: `Allow ${subject} — ${option.note}`,
        hint: "",
        hintStyle: "note",
        messageable: false,
        outcome: {
          allow: true,
          persist: {
            id: `${option.grant}-broad`,
            label: `Allow ${subject}`,
            pattern: broadPattern,
            hint: broadHint,
            grant: option.grant,
          },
        },
      });
    }
  } else {
    // No prefix scope: fall back to exact-command persistent options.
    const exactScope = request.scopes.find((s) => s.pattern === exactPattern)
      ?? [...request.scopes].reverse().find((s) => s.pattern !== null);
    if (exactScope?.pattern) {
      const hint = exactScope.hint ?? exactScope.pattern;
      const subject = grantSubject(request, hint);
      for (const option of PERSISTENT_GRANTS) {
        choices.push({
          label: `Allow ${subject} — ${option.note}`,
          hint: "",
          hintStyle: "note",
          messageable: false,
          outcome: {
            allow: true,
            persist: {
              id: option.grant,
              label: `Allow ${subject}`,
              pattern: exactScope.pattern,
              hint,
              grant: option.grant,
            },
          },
        });
      }
    }
  }

  return choices;
}

function descriptorArgs(request: PermissionRequest): Record<string, unknown> {
  if (request.arguments !== undefined) return request.arguments;
  if (request.tool === "run_shell") return { command: request.subject };
  if (request.tool === "write_file" || request.tool === "edit_file" || request.tool === "read_file") {
    return { path: request.subject };
  }
  return {};
}

export function PermissionModal({
  request,
  permissionQueueDepth = 1,
  queuedApprovals = [],
  goalTimeoutMs = null,
  onResolve,
  width = 80,
}: PermissionModalProps): ReactNode {
  const queuedBehind = Math.max(0, permissionQueueDepth - 1);
  // Everything behind the currently visible entry, distinguished by agent.
  const otherQueued = queuedApprovals.slice(1);
  const shownQueued = otherQueued.slice(0, MAX_RENDERED_QUEUE_ENTRIES);
  const hiddenQueuedCount = otherQueued.length - shownQueued.length;
  const choices = buildChoices(request);
  const [selected, setSelected] = useState(0);
  const [message, setMessage] = useState("");
  const [expanded, setExpanded] = useState(false);
  const descriptor = describeToolCall(
    request.tool,
    JSON.stringify(descriptorArgs(request)),
  );
  const toolColor = color(descriptor.role);
  const summary = clampForDisplay(sanitizeForPrompt(descriptor.summary));
  const allShellSegments = descriptor.isShell
    ? groupChainSegmentsForDisplay(request.subject).filter((segment) => !isShellCommentOnly(segment))
    : [];
  const cappedSegments = allShellSegments.slice(0, MAX_RENDERED_SEGMENTS);
  const hiddenSegmentCount = allShellSegments.length - cappedSegments.length;
  // Collapse heredoc/quoted-string payloads before sanitizing so an embedded
  // newline is recognized as a payload boundary, not just turned into a ↵
  // marker — this is what lets the command render once, as one line per
  // segment, with no separate raw dump underneath.
  const collapsedSegments = cappedSegments.map((segment) => {
    const collapsed = collapseSegmentPayloads(segment);
    return {
      display: clampForDisplay(sanitizeForPrompt(collapsed.display)),
      payloads: collapsed.payloads,
    };
  });

  const activeChoice = choices[selected];
  const messageMode = message.length > 0 || false;
  const goalTimeoutSecs =
    goalTimeoutMs !== null && goalTimeoutMs !== undefined && goalTimeoutMs > 0
      ? Math.max(1, Math.round(goalTimeoutMs / 1000))
      : null;


  useInput((input, key) => {
    if (key.escape) {
      if (message.length > 0) {
        setMessage("");
        return;
      }
      onResolve({ allow: false });
      return;
    }

    if (key.return) {
      if (!activeChoice) return;
      const trimmed = message.trim();
      onResolve(trimmed.length > 0 ? { ...activeChoice.outcome, message: trimmed } : activeChoice.outcome);
      return;
    }

    if (key.ctrl && input === "o") {
      setExpanded((e) => !e);
      return;
    }

    if (key.ctrl && (key.upArrow || key.downArrow)) return;
    if (key.upArrow && message.length === 0) {
      setSelected((s) => (s > 0 ? s - 1 : choices.length - 1));
      return;
    }
    if (key.downArrow && message.length === 0) {
      setSelected((s) => (s < choices.length - 1 ? s + 1 : 0));
      return;
    }

    if (key.backspace || key.delete) {
      setMessage((m) => m.slice(0, -1));
      return;
    }

    // Number keys jump straight to an option and resolve it, as long as the user
    // is not mid-message (where digits are part of the typed explanation).
    if (message.length === 0 && /^[1-9]$/.test(input)) {
      const index = Number(input) - 1;
      const choice = choices[index];
      if (choice) {
        onResolve(choice.outcome);
        return;
      }
    }

    if (input && !key.ctrl && !key.meta && activeChoice?.messageable) {
      setMessage((m) => m + input);
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={toolColor}
      paddingX={2}
      paddingY={1}
      marginX={1}
      marginY={1}
      width={Math.max(24, width - 2)}
    >
      <Text bold color={toolColor}>Approval needed</Text>
      {request.agentLabel !== undefined && (
        <Text>
          <Text color={agentTagColor(request.agentLabel)} bold>{`⏺ ${request.agentLabel}`}</Text>
          {request.cwd !== undefined && (
            <Text color={color("muted")}>{`  ${request.cwd}`}</Text>
          )}
        </Text>
      )}
      {goalTimeoutSecs !== null && (
        <Text color={color("muted")}>
          {`Goal mode · auto-skip in ~${goalTimeoutSecs}s if no response`}
        </Text>
      )}
      <Box marginTop={1} flexDirection="column" gap={0}>

        <Text color={color("muted")}>
          {request.action}
          {descriptor.isShell ? null : (
            <>
              {": "}
              <Text color={toolColor}>{descriptor.display}</Text>
            </>
          )}
          {queuedBehind > 0
            ? ` · +${queuedBehind} more approval${queuedBehind === 1 ? "" : "s"} queued`
            : ""}
        </Text>
        {shownQueued.length > 0 && (
          <Box marginLeft={2} flexDirection="column">
            {shownQueued.map((entry) => (
              <Text key={entry.id} color={color("muted")}>
                {"· "}
                {entry.agentLabel !== undefined ? (
                  <Text color={agentTagColor(entry.agentLabel)}>{entry.agentLabel}</Text>
                ) : (
                  <Text color={color("muted")}>session</Text>
                )}
                {` — ${entry.tool}`}
              </Text>
            ))}
            {hiddenQueuedCount > 0 && (
              <Text color={color("muted")}>{`… ${hiddenQueuedCount} more waiting`}</Text>
            )}
          </Box>
        )}
        {collapsedSegments.length > 0 ? (
          // The command renders exactly once, as this segment list — no
          // separate raw dump. Heredoc/quoted payloads are already collapsed
          // to a placeholder; Ctrl+O reveals their full text below each one.
          <Box marginLeft={2} flexDirection="column">
            {collapsedSegments.map((segment, i) => (
              <Box key={i} flexDirection="column">
                <Text color={color("text")} wrap="wrap">
                  {collapsedSegments.length > 1 ? `${i + 1}. ${segment.display}` : segment.display}
                </Text>
                {expanded &&
                  segment.payloads.map((payload, pi) => {
                    const lines = payload.lines.slice(0, MAX_RENDERED_LINES);
                    const hiddenLines = payload.lines.length - lines.length;
                    return (
                      <Box key={pi} marginLeft={3} flexDirection="column">
                        {lines.map((line, li) => (
                          <Text key={li} color={color("muted")} wrap="wrap">
                            {clampForDisplay(sanitizeForPrompt(line))}
                          </Text>
                        ))}
                        {hiddenLines > 0 && (
                          <Text color={color("muted")}>{`… ${hiddenLines} more lines`}</Text>
                        )}
                      </Box>
                    );
                  })}
              </Box>
            ))}
            {hiddenSegmentCount > 0 && (
              <Text color={color("muted")}>{`… ${hiddenSegmentCount} more segments`}</Text>
            )}
            {collapsedSegments.length > 1 && (
              <Text color={color("muted")}>
                One decision covers every segment — rejecting any blocks the whole command.
              </Text>
            )}
          </Box>
        ) : summary.length > 0 ? (
          <Box marginLeft={2}>
            <Text color={color("text")} wrap="wrap">{summary}</Text>
          </Box>
        ) : null}
      </Box>
      {request.notice !== undefined && (
        <Box marginTop={1}>
          <Text color={color("muted")}>{sanitizeForPrompt(request.notice)}</Text>
        </Box>
      )}
      <Box marginTop={1} flexDirection="column">
        {choices.map((choice, i) => {
          const isReject = choice.outcome.allow === false;
          const tone = isReject ? color("danger") : color("success");
          const active = i === selected;
          // The message is operator-typed; the hint carries the model-authored
          // command pattern and needs the same sanitization as the subject.
          const hintText = active && messageMode
            ? message
            : expanded
              ? sanitizeForPrompt(choice.hint)
              : truncateChoiceText(sanitizeForPrompt(choice.hint), width);
          const hintOpen = choice.hintStyle === "command" ? "[" : "(";
          const hintClose = choice.hintStyle === "command" ? "]" : ")";
          const hintColor = choice.hintStyle === "command" ? color("muted") : color("muted");
          const hintDim = choice.hintStyle === "command";
          // Persistent Allow choices carry their scope in the label itself
          // (see grantSubject) and set hint to "" — nothing left to show in a
          // second, dimmer bracket, so the bracket is omitted entirely rather
          // than rendering an empty "()" pair.
          const showHint = choice.hint.length > 0 || (active && messageMode);
          return (
            <Text key={i} wrap="wrap">
              <Text color={active ? color("brand") : color("muted")} bold={active}>
                {active ? "› " : "  "}
              </Text>
              <Text color={color("muted")}>{`${i + 1}. `}</Text>
              <Text color={active ? tone : color("text")} bold={active}>
                {expanded
                  ? sanitizeForPrompt(choice.label)
                  : truncateChoiceText(sanitizeForPrompt(choice.label), width)}
              </Text>
              {showHint && (
                <>
                  {"  "}
                  <Text color={hintColor} dimColor={hintDim}>
                    {hintOpen}
                  </Text>
                  <Text color={hintColor} dimColor={hintDim}>
                    {hintText}
                  </Text>
                  {active && messageMode && (
                    <Text color={color("brand")}>▌</Text>
                  )}
                  <Text color={hintColor} dimColor={hintDim}>
                    {hintClose}
                  </Text>
                </>
              )}
            </Text>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={color("muted")}>
          {messageMode
            ? "Enter confirm · Esc clear · ↑↓ navigate"
            : `1-${choices.length} select · ↑↓ navigate · Enter choose · Ctrl+O ${expanded ? "collapse" : "expand"} · Esc reject`}
        </Text>
      </Box>
    </Box>
  );
}
