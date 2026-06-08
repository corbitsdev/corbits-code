import { Box, Text, useInput } from "ink";
import type { ReactNode } from "react";
import { useState } from "react";
import type { ApprovalOutcome, PermissionRequest } from "../../permission/types.js";
import { color } from "../theme.js";
import { describeToolCall } from "../tool-formatter.js";

export type PermissionModalProps = {
  request: PermissionRequest;
  onResolve: (outcome: ApprovalOutcome) => void;
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

function buildChoices(request: PermissionRequest): Choice[] {
  const choices: Choice[] = [
    {
      label: "Allow Once",
      hint: "start typing to add a message",
      hintStyle: "note",
      messageable: true,
      outcome: { allow: true },
    },
  ];
  for (const scope of request.scopes) {
    if (scope.pattern === null) continue;
    choices.push({
      label: scope.label,
      hint: scope.pattern,
      hintStyle: "command",
      messageable: false,
      outcome: { allow: true, persist: scope },
    });
  }
  choices.push({
    label: "Reject",
    hint: "start typing to add a message",
    hintStyle: "note",
    messageable: true,
    outcome: { allow: false },
  });
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

export function PermissionModal({ request, onResolve }: PermissionModalProps): ReactNode {
  const choices = buildChoices(request);
  const [selected, setSelected] = useState(0);
  const [message, setMessage] = useState("");
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
    >
      <Text bold color={toolColor}>Approval needed</Text>
      <Box marginTop={1} flexDirection="column" gap={0}>
        <Text color={color("muted")}>
          {request.action}:{" "}
          <Text color={toolColor}>{descriptor.display}</Text>
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
            <Text key={i}>
              <Text color={active ? color("brand") : color("muted")} bold={active}>
                {active ? "› " : "  "}
              </Text>
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
            : "↑↓ navigate · Enter choose · Esc reject"}
        </Text>
      </Box>
    </Box>
  );
}
