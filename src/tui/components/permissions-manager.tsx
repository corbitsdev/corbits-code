import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { ReactNode } from "react";
import type { GrantScope } from "../../permission/types.js";
import type { ScopedApproval } from "../../permission/admin.js";
import { color } from "../theme.js";

export type PermissionsManagerProps = {
  entries: ScopedApproval[];
  onRevoke: (entry: ScopedApproval) => void;
  onClose: () => void;
  maxHeight?: number;
};

const SCOPE_LABEL: Record<GrantScope, string> = {
  session: "This session",
  project: "This project",
  global: "Global",
  "provider-model": "Provider / model",
};

const SCOPE_ORDER: GrantScope[] = ["session", "project", "global", "provider-model"];

function orderEntries(entries: ScopedApproval[]): ScopedApproval[] {
  return SCOPE_ORDER.flatMap((scope) => entries.filter((e) => e.scope === scope));
}

function entryLabel(entry: ScopedApproval): string {
  const suffix = entry.providerModel !== undefined ? `  (${entry.providerModel})` : "";
  return `${entry.tool}  ${entry.pattern}${suffix}`;
}

// Fixed rows consumed by the box chrome (borders, padding, title, hint footer).
const FIXED_CHROME = 6;

export function PermissionsManager({ entries, onRevoke, onClose, maxHeight }: PermissionsManagerProps): ReactNode {
  const ordered = orderEntries(entries);
  const [selected, setSelected] = useState(0);
  const active = ordered.length > 0 ? Math.min(selected, ordered.length - 1) : 0;

  // Determine how many entry rows are visible given the height budget.
  const availableEntryRows = maxHeight !== undefined ? Math.max(1, maxHeight - FIXED_CHROME) : undefined;
  // Scroll offset: keep the active entry visible within the window.
  const scrollOffset = availableEntryRows !== undefined && availableEntryRows < ordered.length
    ? Math.max(0, Math.min(active - Math.floor(availableEntryRows / 2), ordered.length - availableEntryRows))
    : 0;
  const visibleEntries = availableEntryRows !== undefined
    ? ordered.slice(scrollOffset, scrollOffset + availableEntryRows)
    : ordered;

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (ordered.length === 0) return;
    if (key.upArrow) {
      setSelected((s) => (s > 0 ? s - 1 : ordered.length - 1));
      return;
    }
    if (key.downArrow) {
      setSelected((s) => (s < ordered.length - 1 ? s + 1 : 0));
      return;
    }
    if (input === "d" || key.delete || key.backspace) {
      const target = ordered[active];
      if (target !== undefined) {
        // The parent reloads the list after a revoke, shifting indices. Drop the
        // cursor to the top now so a follow-up keystroke can't revoke a row that
        // slid under it.
        setSelected(0);
        onRevoke(target);
      }
    }
  });

  return (
    <Box
      flexDirection="column"
      paddingX={2}
      paddingY={1}
      marginX={1}
      marginY={1}
    >
      <Text bold color={color("accent")}>Permissions</Text>
      {ordered.length === 0 ? (
        <Box marginTop={1}>
          <Text color={color("muted")}>No remembered approvals. Grants you accept will appear here.</Text>
        </Box>
      ) : (
        SCOPE_ORDER.map((scope) => {
          const scoped = visibleEntries.filter((e) => e.scope === scope);
          if (scoped.length === 0) return null;
          return (
            <Box key={scope} flexDirection="column" marginTop={1}>
              <Text bold color={color("muted")}>{SCOPE_LABEL[scope]}</Text>
              {scoped.map((entry) => {
                const globalIndex = ordered.indexOf(entry);
                const isActive = globalIndex === active;
                return (
                  <Box key={`${scope}-${globalIndex}`} marginLeft={1}>
                    <Text color={isActive ? color("brand") : color("muted")} bold={isActive}>
                      {isActive ? "› " : "  "}
                    </Text>
                    <Text bold={isActive}>
                      {entryLabel(entry)}
                    </Text>
                  </Box>
                );
              })}
            </Box>
          );
        })
      )}
      <Box marginTop={1}>
        <Text color={color("muted")}>
          {ordered.length === 0 ? "Esc to close" : "↑↓ navigate · d revoke · Esc close"}
        </Text>
      </Box>
    </Box>
  );
}
