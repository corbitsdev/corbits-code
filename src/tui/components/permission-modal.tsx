import { Box, Text, useInput } from "ink";
import type { ReactNode } from "react";
import { useState } from "react";
import type { ApprovalOutcome, ApprovalScope, GrantScope, PermissionRequest } from "../../permission/types.js";
import { color } from "../theme.js";
import { describeToolCall } from "../tool-formatter.js";

export type PermissionModalProps = {
  request: PermissionRequest;
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

const GRANT_OPTIONS: { grant: GrantScope; label: string; note: string }[] = [
  { grant: "session", label: "Auto-accept this session", note: "until this session ends" },
  { grant: "project", label: "Auto-accept in this project", note: "persisted per repo" },
  { grant: "global", label: "Auto-accept globally", note: "all projects" },
  { grant: "provider-model", label: "Auto-accept for this provider/model", note: "scoped to the active model" },
];

// The pattern a grant remembers. The scope ladder runs broadest-first
// (`bun run *`) to narrowest (`bun run typecheck`); a one-keystroke grant should
// remember the exact command the user is looking at, not silently authorize the
// whole wildcard — so prefer the exact-subject scope, then the narrowest
// persistable rung, and fall back to the raw subject.
function grantPattern(request: PermissionRequest): { pattern: string; hint: string } | null {
  const exact = request.scopes.find((scope) => scope.pattern === request.subject);
  const narrowest = [...request.scopes].reverse().find((scope) => scope.pattern !== null);
  const chosen = exact ?? narrowest;
  if (chosen === undefined || chosen.pattern === null) return null;
  return { pattern: chosen.pattern, hint: chosen.hint ?? chosen.pattern };
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

  const grant = grantPattern(request);
  if (grant === null) return choices;

  for (const option of GRANT_OPTIONS) {
    const scope: ApprovalScope = {
      id: option.grant,
      label: option.label,
      pattern: grant.pattern,
      hint: grant.hint,
      grant: option.grant,
    };
    choices.push({
      label: option.label,
      hint: `${grant.hint} · ${option.note}`,
      hintStyle: "command",
      messageable: false,
      outcome: { allow: true, persist: scope },
    });
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

export function PermissionModal({ request, onResolve, width = 80 }: PermissionModalProps): ReactNode {
  const choices = buildChoices(request);
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
