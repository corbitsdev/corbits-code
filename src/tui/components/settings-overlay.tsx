import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { ReactNode } from "react";
import type { GrantScope } from "../../permission/types.js";
import type { ScopedApproval } from "../../permission/admin.js";
import type { SessionMode } from "../../config/session-mode.js";
import { SESSION_MODES } from "../../config/session-mode.js";
import { color } from "../theme.js";
import { useTerminalSize } from "../hooks/use-terminal-size.js";
import { STACK_FORM_COLUMNS, fitTrailingText, formContentWidth } from "./form-reflow.js";

export type CompactionMode = "llm" | "pruning";

export type SettingsOverlayProps = {
  permissionEntries: ScopedApproval[];
  onRevokePermission: (entry: ScopedApproval) => void;
  compactionMode: CompactionMode;
  onChangeCompactionMode: (mode: CompactionMode) => void;
  maxConcurrentSubAgents: number;
  onChangeMaxConcurrentSubAgents: (limit: number) => void;
  sessionMode: SessionMode;
  savedGlobalSessionMode?: SessionMode;
  savedLocalSessionMode?: SessionMode;
  onChangeSessionMode: (mode: SessionMode, scope: "global" | "local") => void;
  telemetryEnabled: boolean;
  onChangeTelemetryEnabled: (enabled: boolean) => void;
  /**
   * When true (default), freeze each tool's wall-clock budget while its
   * permission prompt is open. When false, the budget keeps ticking.
   */
  waitForApproval: boolean;
  onChangeWaitForApproval: (value: boolean) => void;
  onClose: () => void;
  maxHeight?: number;
};

const TABS = ["Permissions", "Compaction", "Session", "Sub-agents", "Tools", "Telemetry"] as const;
type Tab = (typeof TABS)[number];

const COMPACTION_OPTIONS: { value: CompactionMode; label: string; description: string }[] = [
  {
    value: "llm",
    label: "Summarize",
    description:
      "At ~60% of the context window, makes a lightweight LLM call to produce a structured handoff " +
      "(goal, active tasks, key files, decisions, next steps), then replaces the older turns with that text. " +
      "The next turn picks up from the summary rather than the raw history.",
  },
  {
    value: "pruning",
    label: "Drop",
    description:
      "At ~60% of the context window, older turns are deleted and replaced with a one-paragraph note " +
      "listing how many turns were removed, which tools were called, and the last user message. " +
      "No inference call — use when conversation history is not load-bearing.",
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

function TabBar({
  activeTab,
  onSwitch,
  stack,
}: {
  activeTab: Tab;
  onSwitch: (t: Tab) => void;
  stack: boolean;
}): ReactNode {
  return (
    <Box
      flexDirection={stack ? "column" : "row"}
      flexWrap={stack ? undefined : "wrap"}
      gap={stack ? 0 : 2}
      marginBottom={1}
    >
      <Box flexDirection="row" flexWrap="wrap" gap={stack ? 1 : 2}>
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
      </Box>
      <Text color={color("muted")}>{stack ? "Tab to switch" : "  Tab to switch sections"}</Text>
    </Box>
  );
}

function PermissionsTab({
  entries,
  onRevoke,
  maxRows,
  contentWidth,
}: {
  entries: ScopedApproval[];
  onRevoke: (entry: ScopedApproval) => void;
  maxRows?: number | undefined;
  contentWidth: number;
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
                  <Text bold={isActive}>
                    {fitTrailingText(entryLabel(entry), Math.max(8, contentWidth - 4))}
                  </Text>
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

const SESSION_MODE_LABEL: Record<SessionMode, string> = {
  single: "Single agent",
  orchestrator: "Orchestrator",
};

function SessionModeTab({
  current,
  savedGlobal,
  savedLocal,
  onChange,
}: {
  current: SessionMode;
  savedGlobal?: SessionMode;
  savedLocal?: SessionMode;
  onChange: (mode: SessionMode, scope: "global" | "local") => void;
}): ReactNode {
  const currentIndex = SESSION_MODES.indexOf(current);
  const [selected, setSelected] = useState(currentIndex >= 0 ? currentIndex : 0);
  const [scope, setScope] = useState<"global" | "local">("global");

  useInput((_input, key) => {
    if (key.upArrow) {
      setSelected((s) => (s > 0 ? s - 1 : SESSION_MODES.length - 1));
    } else if (key.downArrow) {
      setSelected((s) => (s < SESSION_MODES.length - 1 ? s + 1 : 0));
    } else if (_input === "g") setScope("global");
    else if (_input === "l") setScope("local");
    else if (key.return || _input === " ") {
      const mode = SESSION_MODES[selected];
      if (mode !== undefined) onChange(mode, scope);
    }
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={color("muted")} bold>
        Session mode
      </Text>
      <Text color={color("muted")}>
        Single: one agent does the work. Orchestrator: delegates via task. Per-repo override saves to
        .corbits/settings.json (l); global saves to ~/.corbits/settings.json (g). Takes effect on next
        session start.
      </Text>
      <Box marginTop={1}>
        <Text color={color("muted")}>
          Save target: {scope === "global" ? "global (g)" : "this project (l)"}
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {SESSION_MODES.map((mode, index) => {
          const isSelected = index === selected;
          const isActive = mode === current;
          const savedForScope = scope === "global" ? savedGlobal : savedLocal;
          const isSaved = savedForScope !== undefined && mode === savedForScope;
          return (
            <Box key={mode} marginBottom={1}>
              <Text color={isSelected ? color("brand") : color("muted")} bold={isSelected}>
                {isSelected ? "› " : "  "}
              </Text>
              <Text bold={isSelected || isActive} {...(isActive ? { color: color("success") } : {})}>
                {SESSION_MODE_LABEL[mode]}
              </Text>
              {isActive && <Text color={color("success")}> (active this session)</Text>}
              {!isActive && isSaved && (
                <Text color={color("muted")}> (saved — next session)</Text>
              )}
            </Box>
          );
        })}
      </Box>
      <Text color={color("muted")}>↑↓ navigate · Enter select · g global · l local</Text>
    </Box>
  );
}

function SubAgentsTab({
  current,
  onChange,
  sessionMode,
}: {
  current: number;
  onChange: (limit: number) => void;
  sessionMode: SessionMode;
}): ReactNode {
  useInput((_input) => {
    if (sessionMode === "single") return;
    if (_input === "+" || _input === "=") onChange(current + 1);
    else if (_input === "-" || _input === "_") onChange(Math.max(0, current - 1));
  });

  if (sessionMode === "single") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color={color("muted")}>
          Sub-agent concurrency applies only in orchestrator mode. Switch session mode on the Session tab.
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={color("muted")} bold>
        Concurrent sub-agents
      </Text>
      <Text color={color("muted")}>
        Maximum task-tool workers running at once (each has its own LSP and context store). Takes effect
        immediately; also saved to ~/.corbits/settings.json.
      </Text>
      <Box marginTop={1}>
        <Text bold>
          Limit: {current}
          {current === 0 ? " (sub-agents disabled)" : ""}
        </Text>
      </Box>
      <Text color={color("muted")}>+ / − to adjust (0 disables sub-agents)</Text>
    </Box>
  );
}

const WAIT_FOR_APPROVAL_OPTIONS: { value: boolean; label: string; description: string }[] = [
  {
    value: true,
    label: "On (default)",
    description:
      "While a permission prompt is open, freeze that tool's wall-clock budget so a late approve " +
      "still runs the tool. The agent waits for your decision instead of timing out under the modal.",
  },
  {
    value: false,
    label: "Off",
    description:
      "The tool budget keeps ticking during the permission prompt. If it expires first, the tool is " +
      "skipped and the prompt is dismissed automatically.",
  },
];

function ToolsTab({
  waitForApproval,
  onChangeWaitForApproval,
}: {
  waitForApproval: boolean;
  onChangeWaitForApproval: (value: boolean) => void;
}): ReactNode {
  const currentIndex = WAIT_FOR_APPROVAL_OPTIONS.findIndex((o) => o.value === waitForApproval);
  const [selected, setSelected] = useState(currentIndex >= 0 ? currentIndex : 0);

  useInput((_input, key) => {
    if (key.upArrow) {
      setSelected((s) => (s > 0 ? s - 1 : WAIT_FOR_APPROVAL_OPTIONS.length - 1));
    } else if (key.downArrow) {
      setSelected((s) => (s < WAIT_FOR_APPROVAL_OPTIONS.length - 1 ? s + 1 : 0));
    } else if (key.return || _input === " ") {
      const opt = WAIT_FOR_APPROVAL_OPTIONS[selected];
      if (opt !== undefined) onChangeWaitForApproval(opt.value);
    }
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={color("muted")} bold>
        Wait for approval
      </Text>
      <Text color={color("muted")}>
        Controls whether a parked permission prompt counts against the per-tool timeout. Takes effect
        on the next tool call; also saved to ~/.corbits/settings.json.
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {WAIT_FOR_APPROVAL_OPTIONS.map((opt, index) => {
          const isSelected = index === selected;
          const isActive = opt.value === waitForApproval;
          return (
            <Box key={opt.label} flexDirection="column" marginBottom={1}>
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

const TELEMETRY_OPTIONS: { value: boolean; label: string; description: string }[] = [
  {
    value: true,
    label: "On",
    description:
      "Sends a small amount of anonymous usage telemetry to PostHog (session outcomes, model/provider " +
      "identifiers, token counts). Never includes prompts, code, file contents, or paths. See docs/TELEMETRY.md.",
  },
  {
    value: false,
    label: "Off",
    description: "No telemetry is sent.",
  },
];

function TelemetryTab({
  current,
  onChange,
}: {
  current: boolean;
  onChange: (enabled: boolean) => void;
}): ReactNode {
  const currentIndex = TELEMETRY_OPTIONS.findIndex((o) => o.value === current);
  const [selected, setSelected] = useState(currentIndex >= 0 ? currentIndex : 0);

  useInput((_input, key) => {
    if (key.upArrow) {
      setSelected((s) => (s > 0 ? s - 1 : TELEMETRY_OPTIONS.length - 1));
    } else if (key.downArrow) {
      setSelected((s) => (s < TELEMETRY_OPTIONS.length - 1 ? s + 1 : 0));
    } else if (key.return || _input === " ") {
      const opt = TELEMETRY_OPTIONS[selected];
      if (opt !== undefined) onChange(opt.value);
    }
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={color("muted")} bold>Anonymous usage telemetry</Text>
      <Text color={color("muted")}>Takes effect immediately, for the rest of this session and future ones.</Text>
      <Box flexDirection="column" marginTop={1}>
        {TELEMETRY_OPTIONS.map((opt, index) => {
          const isSelected = index === selected;
          const isActive = opt.value === current;
          return (
            <Box key={opt.label} flexDirection="column" marginBottom={1}>
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
  maxConcurrentSubAgents,
  onChangeMaxConcurrentSubAgents,
  sessionMode,
  savedGlobalSessionMode,
  savedLocalSessionMode,
  onChangeSessionMode,
  telemetryEnabled,
  onChangeTelemetryEnabled,
  waitForApproval,
  onChangeWaitForApproval,
  onClose,
  maxHeight,
}: SettingsOverlayProps): ReactNode {
  const [activeTab, setActiveTab] = useState<Tab>("Permissions");
  const { columns } = useTerminalSize();
  const stack = columns < STACK_FORM_COLUMNS;
  const contentWidth = formContentWidth(columns, stack);

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
      paddingX={stack ? 1 : 2}
      paddingY={1}
      marginX={1}
      marginY={1}
      width={Math.max(16, columns - 2)}
    >
      <Text bold color={color("accent")}>Settings</Text>
      <TabBar activeTab={activeTab} onSwitch={setActiveTab} stack={stack} />
      {activeTab === "Permissions" && (
        <PermissionsTab
          entries={permissionEntries}
          onRevoke={onRevokePermission}
          maxRows={contentRows}
          contentWidth={contentWidth}
        />
      )}
      {activeTab === "Compaction" && (
        <CompactionTab current={compactionMode} onChange={onChangeCompactionMode} />
      )}
      {activeTab === "Session" && (
        <SessionModeTab
          current={sessionMode}
          {...(savedGlobalSessionMode !== undefined ? { savedGlobal: savedGlobalSessionMode } : {})}
          {...(savedLocalSessionMode !== undefined ? { savedLocal: savedLocalSessionMode } : {})}
          onChange={onChangeSessionMode}
        />
      )}
      {activeTab === "Sub-agents" && (
        <SubAgentsTab
          current={maxConcurrentSubAgents}
          onChange={onChangeMaxConcurrentSubAgents}
          sessionMode={sessionMode}
        />
      )}
      {activeTab === "Tools" && (
        <ToolsTab
          waitForApproval={waitForApproval}
          onChangeWaitForApproval={onChangeWaitForApproval}
        />
      )}
      {activeTab === "Telemetry" && (
        <TelemetryTab current={telemetryEnabled} onChange={onChangeTelemetryEnabled} />
      )}
      <Box marginTop={1}>
        <Text color={color("muted")}>Esc to close</Text>
      </Box>
    </Box>
  );
}
