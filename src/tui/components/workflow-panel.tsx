import { Box, Text, useInput } from "ink";
import { useState, type ReactNode } from "react";
import { color } from "../theme.js";
import type { CapabilityName } from "../../workflows/types.js";
import type { WorkflowStatus } from "../workflow-controller.js";

export type WorkflowPanelProps = {
  status: WorkflowStatus;
  width: number;
  maxRows: number;
  onToggleCapability: (name: CapabilityName) => void;
  onClose: () => void;
};

const STEP_ICON: Record<string, string> = {
  completed: "✓",
  active: "→",
  pending: "·",
  skipped: "⊘",
};

function stepTone(statusValue: string): string {
  if (statusValue === "completed") return color("success");
  if (statusValue === "active") return color("accent");
  if (statusValue === "skipped") return color("muted");
  return color("text");
}

// Right-sidebar panel showing the active workflow's steps, and a capability
// sub-view (toggle with "c") for enabling/disabling integrations for the run.
// Owns keyboard input while open (Ctrl+W / Esc close; ↑/↓ navigate; space
// toggles a capability in the capability view).
export function WorkflowPanel({
  status,
  width,
  maxRows,
  onToggleCapability,
  onClose,
}: WorkflowPanelProps): ReactNode {
  const [view, setView] = useState<"steps" | "capabilities">("steps");
  const [selected, setSelected] = useState(0);

  const capCount = status.capabilities.length;

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "w")) {
      onClose();
      return;
    }
    if (input === "c") {
      setView((v) => (v === "steps" ? "capabilities" : "steps"));
      setSelected(0);
      return;
    }
    if (view === "capabilities") {
      if (key.upArrow) setSelected((i) => Math.max(0, i - 1));
      else if (key.downArrow) setSelected((i) => Math.min(capCount - 1, i + 1));
      else if (input === " ") {
        const cap = status.capabilities[selected];
        if (cap !== undefined) onToggleCapability(cap.name);
      }
    }
  });

  return (
    <Box flexDirection="column" width={width} borderStyle="round" borderColor={color("accent")} paddingX={1} overflow="hidden">
      {view === "steps" ? (
        <StepsView status={status} maxRows={maxRows} />
      ) : (
        <CapabilitiesView status={status} selected={selected} maxRows={maxRows} />
      )}
      <Text color={color("muted")}>
        {view === "steps" ? "c capabilities · Esc close" : "space toggle · c steps · Esc close"}
      </Text>
    </Box>
  );
}

function StepsView({ status, maxRows }: { status: WorkflowStatus; maxRows: number }): ReactNode {
  const header = status.active ? `${status.name} · ${status.stepIndex + 1}/${status.total}` : "no active workflow";
  const visible = status.steps.slice(0, Math.max(1, maxRows));
  return (
    <>
      <Text bold color={color("accent")}>{header}</Text>
      {status.steps.length === 0 && <Text color={color("muted")}>Start one with /workflows</Text>}
      {visible.map((step, i) => (
        <Text key={i} color={stepTone(step.status)} wrap="truncate-end">
          {STEP_ICON[step.status] ?? "·"} {step.label}
          {step.status === "skipped" && step.capability !== undefined ? (
            <Text color={color("muted")}> (needs {step.capability})</Text>
          ) : null}
        </Text>
      ))}
    </>
  );
}

function CapabilitiesView({
  status,
  selected,
  maxRows,
}: {
  status: WorkflowStatus;
  selected: number;
  maxRows: number;
}): ReactNode {
  const visible = status.capabilities.slice(0, Math.max(1, maxRows));
  return (
    <>
      <Text bold color={color("accent")}>capabilities</Text>
      {visible.map((cap, i) => {
        const state = !cap.connected ? "not connected" : cap.disabled ? "disabled" : "enabled";
        const tone = !cap.connected ? color("muted") : cap.disabled ? color("warning") : color("success");
        return (
          <Text key={cap.name} color={tone} wrap="truncate-end">
            {i === selected ? "▶ " : "  "}
            [{cap.disabled || !cap.connected ? " " : "x"}] {cap.name} — {state}
            {cap.source !== undefined ? <Text color={color("muted")}> ({cap.source})</Text> : null}
          </Text>
        );
      })}
    </>
  );
}
