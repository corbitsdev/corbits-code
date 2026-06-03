import { Box, Text, useInput } from "ink";
import type { ReactNode } from "react";
import { useState } from "react";
import type { ApprovalOutcome, PermissionRequest } from "../../permission/types.js";
import { color } from "../theme.js";

export type PermissionModalProps = {
  request: PermissionRequest;
  onResolve: (outcome: ApprovalOutcome) => void;
};

type Choice = { label: string; hint: string; outcome: ApprovalOutcome };

function buildChoices(request: PermissionRequest): Choice[] {
  const always = request.scopes[0];
  const choices: Choice[] = [{ label: "Allow Once", hint: "just this time", outcome: { allow: true } }];
  if (always !== undefined && always.pattern !== null) {
    choices.push({
      label: "Allow Always",
      hint: always.pattern,
      outcome: { allow: true, persist: always },
    });
  }
  choices.push({ label: "Reject", hint: "do not run", outcome: { allow: false } });
  return choices;
}

export function PermissionModal({ request, onResolve }: PermissionModalProps): ReactNode {
  const choices = buildChoices(request);
  const [selected, setSelected] = useState(0);

  useInput((_input, key) => {
    if (key.upArrow) {
      setSelected((s) => (s > 0 ? s - 1 : choices.length - 1));
      return;
    }
    if (key.downArrow) {
      setSelected((s) => (s < choices.length - 1 ? s + 1 : 0));
      return;
    }
    if (key.escape) {
      onResolve({ allow: false });
      return;
    }
    if (key.return) {
      onResolve(choices[selected]?.outcome ?? { allow: false });
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={color("brand")}
      paddingX={2}
      paddingY={1}
      marginX={1}
      marginY={1}
    >
      <Text bold color={color("brand")}>Approval needed</Text>
      <Box marginTop={1} flexDirection="row" gap={1}>
        <Text color={color("muted")}>{request.action}:</Text>
        <Text color={color("text")}>{request.subject}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {choices.map((choice, i) => {
          const isReject = choice.outcome.allow === false;
          const tone = isReject ? color("danger") : color("success");
          const active = i === selected;
          return (
            <Text key={i}>
              <Text color={active ? color("brand") : color("muted")} bold={active}>
                {active ? "› " : "  "}
              </Text>
              <Text color={active ? tone : color("text")} bold={active}>
                {choice.label}
              </Text>
              <Text color={color("muted")}>  ({choice.hint})</Text>
            </Text>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={color("muted")}>↑↓ navigate · Enter choose · Esc reject</Text>
      </Box>
    </Box>
  );
}
