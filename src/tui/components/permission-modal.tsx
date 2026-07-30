import { Box, Text, useInput } from "ink";
import type { ReactNode } from "react";
import { useState } from "react";
import type { ApprovalOutcome, ApprovalScope, GrantScope, PermissionRequest } from "../../permission/types.js";
import { color } from "../theme.js";
import { describeToolCall } from "../tool-formatter.js";
import { stripTerminalControlSequences } from "../../util/control-char-strip.js";
import { splitChainedCommand, isShellCommentOnly } from "../../permission/command.js";

// Bidi controls (RLO, embeddings, isolates) visually reorder the rendered
// command — Trojan Source — and zero-width characters hide payload boundaries,
// so a spoofed command can read as harmless in a security prompt.
const BIDI_AND_ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

// Display-only caps: a model-authored command can be arbitrarily long or have
// thousands of chain segments, which would push the Reject/Accept choices off
// screen (and stall layout). The executed and persisted command is never
// touched — only what the modal draws.
const MAX_RENDERED_SEGMENTS = 12;
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

export type PermissionModalProps = {
  request: PermissionRequest;
  /** Permission gates still queued, including this modal. */
  permissionQueueDepth?: number;
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
    for (const option of PERSISTENT_GRANTS) {
      choices.push({
        label: `Allow ${broadPattern}`,
        hint: `${broadHint} · ${option.note}`,
        hintStyle: "command",
        messageable: false,
        outcome: {
          allow: true,
          persist: {
            id: `${option.grant}-broad`,
            label: `Allow ${broadPattern}`,
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
      for (const option of PERSISTENT_GRANTS) {
        choices.push({
          label: `Allow ${hint}`,
          hint: `${hint} · ${option.note}`,
          hintStyle: "command",
          messageable: false,
          outcome: {
            allow: true,
            persist: {
              id: option.grant,
              label: `Allow ${hint}`,
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
  goalTimeoutMs = null,
  onResolve,
  width = 80,
}: PermissionModalProps): ReactNode {
  const queuedBehind = Math.max(0, permissionQueueDepth - 1);
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
    ? splitChainedCommand(request.subject).filter((segment) => !isShellCommentOnly(segment))
    : [];
  const shellSegments = allShellSegments
    .slice(0, MAX_RENDERED_SEGMENTS)
    .map((segment) => clampForDisplay(sanitizeForPrompt(segment)));
  const hiddenSegmentCount = allShellSegments.length - shellSegments.length;

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
        {shellSegments.length > 1 ? (
          <Box marginLeft={2} flexDirection="column">
            {shellSegments.map((segment, i) => (
              <Text key={i} color={color("text")} wrap="wrap">{`${i + 1}. ${segment}`}</Text>
            ))}
            {hiddenSegmentCount > 0 && (
              <Text color={color("muted")}>{`… ${hiddenSegmentCount} more segments`}</Text>
            )}
            <Text color={color("muted")}>
              One decision covers every segment — rejecting any blocks the whole command.
            </Text>
          </Box>
        ) : summary.length > 0 ? (
          <Box marginLeft={2}>
            <Text color={color("text")} wrap="wrap">{summary}</Text>
          </Box>
        ) : null}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {choices.map((choice, i) => {
          const isReject = choice.outcome.allow === false;
          const tone = isReject ? color("danger") : color("success");
          const active = i === selected;
          // The message is operator-typed; the hint carries the model-authored
          // command pattern and needs the same sanitization as the subject.
          const hintText = active && messageMode
            ? message
            : clampForDisplay(sanitizeForPrompt(choice.hint));
          const hintOpen = choice.hintStyle === "command" ? "[" : "(";
          const hintClose = choice.hintStyle === "command" ? "]" : ")";
          const hintColor = choice.hintStyle === "command" ? color("muted") : color("muted");
          const hintDim = choice.hintStyle === "command";
          return (
            <Text key={i} wrap={expanded ? "wrap" : "truncate-end"}>
              <Text color={active ? color("brand") : color("muted")} bold={active}>
                {active ? "› " : "  "}
              </Text>
              <Text color={color("muted")}>{`${i + 1}. `}</Text>
              <Text color={active ? tone : color("text")} bold={active}>
                {clampForDisplay(sanitizeForPrompt(choice.label))}
              </Text>
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
