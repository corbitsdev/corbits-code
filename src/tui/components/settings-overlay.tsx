import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { ReactNode } from "react";
import type { GrantScope } from "../../permission/types.js";
import type { ScopedApproval } from "../../permission/admin.js";
import { color } from "../theme.js";

export type CompactionMode = "llm" | "pruning";

export type SettingsOverlayProps = {
  permissionEntries: ScopedApproval[];
  onRevokePermission: (entry: ScopedApproval) => void;
  compactionMode: CompactionMode;
  onChangeCompactionMode: (mode: CompactionMode) => void;
  onClose: () => void;
  maxHeight?: number;
};

const TABS = ["Permissions", "Compaction"] as const;
type Tab = (typeof TABS)[number];

const COMPACTION_OPTIONS: { value: CompactionMode; label: string; description: string }[] = [
  {
    value: "llm",
    label: "Summarize",
    description:
      "At ~60% of the context window, makes a lightweight LLM call to write a structured handoff " +
      "(goal, active tasks, key files, decisions, next steps), then replaces older turns with that summary. " +
      "The next turn sees the handoff in place of the raw history.",
  },
  {
    value: "pruning",
    label: "Drop",
    description:
      "At ~60% of the context window, older turns are silently removed and replaced with a short " +
      "statistical note (turn count, tools called, last user message). No inference call. " +
      "Fastest option — use it when conversation history is not load-bearing.",
  },
];

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

function TabBar({ activeTab, onSwitch }: { activeTab: Tab; onSwitch: (t: Tab) => void }): ReactNode {
  return (
    <Box gap={2} marginBottom={1}>
      {TABS.map((tab) => {
        const isActive = tab === activeTab;
        return (
          <Text
            key={tab}
            bold={isActive}
            color={isActive ? color("brand") : color("muted")}
            underline={isActive}
          >
            {tab}
          </Text>
        );
      })}
      <Text color={color("muted")}>  Tab to switch sections</Text>
    </Box>
  );
}

function PermissionsTab({
  entries,
  onRevoke,
  maxRows,
}: {
  entries: ScopedApproval[];
  onRevoke: (entry: ScopedApproval) => void;
  maxRows?: number | undefined;
}): ReactNode {
  const ordered = orderEntries(entries);
  const [selected, setSelected] = useState(0);
  const active = ordered.length > 0 ? Math.min(selected, ordered.length - 1) : 0;

  const scrollOffset =
    maxRows !== undefined && maxRows < ordered.length
      ? Math.max(0, Math.min(active - Math.floor(maxRows / 2), ordered.length - maxRows))
      : 0;
  const visible = maxRows !== undefined ? ordered.slice(scrollOffset, scrollOffset + maxRows) : ordered;

  useInput((_input, key) => {
    if (ordered.length === 0) return;
    if (key.upArrow) {
      setSelected((s) => (s > 0 ? s - 1 : ordered.length - 1));
    } else if (key.downArrow) {
      setSelected((s) => (s < ordered.length - 1 ? s + 1 : 0));
    } else if (_input === "d" || key.delete || key.backspace) {
      const target = ordered[active];
      if (target !== undefined) {
        setSelected(0);
        onRevoke(target);
      }
    }
  });

  if (ordered.length === 0) {
    return (
      <Box marginTop={1}>
        <Text color={color("muted")}>No remembered approvals. Grants you accept will appear here.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {SCOPE_ORDER.map((scope) => {
        const scoped = visible.filter((e) => e.scope === scope);
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
                  <Text bold={isActive}>{entryLabel(entry)}</Text>
                </Box>
              );
            })}
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text color={color("muted")}>↑↓ navigate · d revoke</Text>
      </Box>
    </Box>
  );
}

function CompactionTab({
  current,
  onChange,
}: {
  current: CompactionMode;
  onChange: (mode: CompactionMode) => void;
}): ReactNode {
  const currentIndex = COMPACTION_OPTIONS.findIndex((o) => o.value === current);
  const [selected, setSelected] = useState(currentIndex >= 0 ? currentIndex : 0);

  useInput((_input, key) => {
    if (key.upArrow) {
      setSelected((s) => (s > 0 ? s - 1 : COMPACTION_OPTIONS.length - 1));
    } else if (key.downArrow) {
      setSelected((s) => (s < COMPACTION_OPTIONS.length - 1 ? s + 1 : 0));
    } else if (key.return || _input === " ") {
      const opt = COMPACTION_OPTIONS[selected];
      if (opt !== undefined) onChange(opt.value);
    }
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={color("muted")} bold>Compaction strategy</Text>
      <Text color={color("muted")}>Applied when context fills — takes effect on the next /clear.</Text>
      <Box flexDirection="column" marginTop={1}>
        {COMPACTION_OPTIONS.map((opt, index) => {
          const isSelected = index === selected;
          const isActive = opt.value === current;
          return (
            <Box key={opt.value} flexDirection="column" marginBottom={1}>
              <Box>
                <Text color={isSelected ? color("brand") : color("muted")} bold={isSelected}>
                  {isSelected ? "› " : "  "}
                </Text>
                <Text bold={isSelected || isActive} {...(isActive ? { color: color("success") } : {})}>
                  {opt.label}
                </Text>
                {isActive && <Text color={color("success")}>{" "}(active)</Text>}
              </Box>
              <Box marginLeft={4}>
                <Text color={color("muted")}>{opt.description}</Text>
              </Box>
            </Box>
          );
        })}
      </Box>
      <Text color={color("muted")}>↑↓ navigate · Enter or Space to select</Text>
    </Box>
  );
}

const FIXED_CHROME = 8;

export function SettingsOverlay({
  permissionEntries,
  onRevokePermission,
  compactionMode,
  onChangeCompactionMode,
  onClose,
  maxHeight,
}: SettingsOverlayProps): ReactNode {
  const [activeTab, setActiveTab] = useState<Tab>("Permissions");

  const contentRows = maxHeight !== undefined ? Math.max(4, maxHeight - FIXED_CHROME) : undefined;

  useInput((_input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (key.tab) {
      setActiveTab((t) => {
        const index = TABS.indexOf(t);
        return TABS[(index + 1) % TABS.length] ?? t;
      });
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={color("accent")}
      paddingX={2}
      paddingY={1}
      marginX={1}
      marginY={1}
    >
      <Text bold color={color("accent")}>Settings</Text>
      <TabBar activeTab={activeTab} onSwitch={setActiveTab} />
      {activeTab === "Permissions" && (
        <PermissionsTab
          entries={permissionEntries}
          onRevoke={onRevokePermission}
          maxRows={contentRows}
        />
      )}
      {activeTab === "Compaction" && (
        <CompactionTab current={compactionMode} onChange={onChangeCompactionMode} />
      )}
      <Box marginTop={1}>
        <Text color={color("muted")}>Esc to close</Text>
      </Box>
    </Box>
  );
}
