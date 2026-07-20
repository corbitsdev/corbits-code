import { Box, Text, useInput } from "ink";
import type { ReactNode } from "react";
import { useState } from "react";
import type { ApprovalOutcome, ApprovalScope, GrantScope, PermissionRequest } from "../../permission/types.js";
import { color } from "../theme.js";
import { describeToolCall } from "../tool-formatter.js";

export type PermissionModalProps = {
  request: PermissionRequest;
  /** Permission gates still queued, including this modal. */
  permissionQueueDepth?: number;
  /**
   * Queued requests identical to this one (same tool and subject), this modal
   * included. One decision resolves the whole identical batch; requests for
   * anything else prompt separately.
   */
  permissionBatchSize?: number;
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

function buildChoices(request: PermissionRequest, batchSize: number): Choice[] {
  const batchCount = Math.max(1, batchSize);
  const onceLabel = batchCount > 1 ? `Accept all ${batchCount}` : "Accept once";
  const onceHint =
    batchCount > 1
      ? `${batchCount} identical calls · start typing to add a message`
      : "this call only · start typing to add a message";
  const rejectLabel = batchCount > 1 ? `Reject all ${batchCount}` : "Reject";

  const choices: Choice[] = [
    {
      label: rejectLabel,
      hint: "start typing to add a message",
      hintStyle: "note",
      messageable: true,
      outcome: { allow: false },
    },
    {
      label: onceLabel,
      hint: onceHint,
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
  permissionBatchSize = 1,
  onResolve,
  width = 80,
}: PermissionModalProps): ReactNode {
  const batchSize = Math.max(1, permissionBatchSize);
  const queuedBehind = Math.max(0, permissionQueueDepth - batchSize);
  const choices = buildChoices(request, batchSize);
  const [selected, setSelected] = useState(0);
  const [message, setMessage] = useState("");
  const [expanded, setExpanded] = useState(false);
  const descriptor = describeToolCall(
    request.tool,
    JSON.stringify(descriptorArgs(request)),
  );
  const toolColor = color(descriptor.role);

  const activeChoice = choices[selected];
  const messageMode = message.length > 0 || false;

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
      <Box marginTop={1} flexDirection="column" gap={0}>
        <Text color={color("muted")}>
          {request.action}
          {descriptor.isShell ? null : (
            <>
              {": "}
              <Text color={toolColor}>{descriptor.display}</Text>
            </>
          )}
          {batchSize > 1 ? ` · ×${batchSize} identical calls` : ""}
          {queuedBehind > 0
            ? ` · +${queuedBehind} more approval${queuedBehind === 1 ? "" : "s"} queued`
            : ""}
        </Text>
        {descriptor.summary.length > 0 && (
          <Box marginLeft={2}>
            <Text color={color("text")} wrap="wrap">{descriptor.summary}</Text>
          </Box>
        )}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {choices.map((choice, i) => {
          const isReject = choice.outcome.allow === false;
          const tone = isReject ? color("danger") : color("success");
          const active = i === selected;
          const hintText = active && messageMode
            ? message
            : choice.hint;
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
                {choice.label}
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
