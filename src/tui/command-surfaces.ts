/**
 * Slash-command surfaces for the OpenTUI host.
 *
 * Commands whose result asks for a surface (settings, permissions, plugins,
 * help, model picker) are routed here and opened on the shared overlay host
 * with host-supplied data. Nothing in this module reaches into session state —
 * every read and write arrives through {@link CommandSurfaceDeps}, so the
 * surfaces stay testable without a live runner.
 */

import { isAbsoluteHTTPURL, validateMCPServerName } from "../mcp/add-server.js";
import { formatPluginWarningsSummary } from "../plugins/diagnostics.js";
import type { PluginOrigin } from "../plugins/admin.js";
import { classifyPluginRemove, isOwnedDiskInstall } from "../plugins/uninstall.js";
import { maskEcho, maskSecret } from "./provider-setup.js";
import { residualIdFromSelection, type ResidualCatalogEntry } from "./residuals.js";
import {
  captureOverlayContinuation,
  closeInsetOverlay,
  isOverlayContinuationCurrent,
  openHelpOverlay,
  openListOverlay,
  openSettingsOverlay,
  setOwnedOverlayItems,
  setStatusFlash,
  type AppShell,
  type ItemDescription,
  type OverlaySelection,
} from "./shell.js";

/** A remembered approval, flattened for display and revocation by id. */
export interface GrantEntry {
  readonly id: string;
  readonly scopeLabel: string;
  readonly tool: string;
  readonly pattern: string;
  readonly providerModel?: string;
}

/** One credential field a plugin's manifest asks for (mirrors PluginCredentialField). */
export interface PluginCredentialFieldEntry {
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  readonly secret?: boolean;
}

/** A discovered plugin with its live enablement, trust, and credential state. */
export interface PluginEntry {
  readonly id: string;
  readonly name: string;
  readonly kind?: string;
  readonly description?: string;
  readonly enabled: boolean;
  readonly needsTrust?: boolean;
  readonly canRevokeTrust?: boolean;
  readonly credentials: readonly PluginCredentialFieldEntry[];
  readonly credentialValues: Readonly<Record<string, string>>;
  readonly agentProfiles?: readonly { readonly id: string; readonly description?: string }[];
  /** Absolute path an untrusted path-origin plugin was discovered at. */
  readonly originPath?: string;
  /**
   * Standing load warnings attributable to this plugin (skill misses named by
   * agent id, failed tool starts, …). Surfaced in the row hint and description.
   */
  readonly warnings?: readonly string[];
  /** Discovery origin stamped at load — never inferred from id. */
  readonly origin: PluginOrigin;
  /** Absolute path the plugin was discovered at. */
  readonly pluginPath?: string;
  /** Provenance label (e.g. "claude"), distinct from origin. */
  readonly source?: string;
}

/** Result of a verify/addPath admin action, reported via `deps.notify`. */
export interface PluginActionResult {
  readonly ok: boolean;
  readonly message: string;
}

/** A web-search candidate the plugins surface can hand to `setWebProvider`. */
export interface WebProviderChoice {
  readonly id: string;
  readonly name: string;
}

export type CompactionMode = "llm" | "pruning";

/** Live values behind the settings surface, re-read on every open. */
export interface SettingsSnapshot {
  readonly compactionMode: CompactionMode;
  readonly waitForApproval: boolean;
  readonly telemetryEnabled: boolean;
  readonly showPromptCost: boolean;
}

export interface PermissionsSurfaceDeps {
  readonly list: () => Promise<readonly GrantEntry[]>;
  readonly revoke: (id: string) => Promise<void>;
}

export interface PluginsSurfaceDeps {
  readonly list: () => readonly PluginEntry[];
  // A trust-grant load can surface skill-miss and similar warnings; the
  // optional message is shown via `deps.notify` at the call site.
  readonly setEnabled: (id: string, enabled: boolean) => Promise<{ message?: string } | undefined>;
  /** Persists credential values for the plugin (does not enable/verify it). */
  readonly saveCredentials: (id: string, credentials: Record<string, string>) => Promise<void>;
  readonly verify: (id: string, credentials: Record<string, string>) => Promise<PluginActionResult>;
  readonly addPath: (path: string) => Promise<PluginActionResult>;
  readonly remove: (id: string) => Promise<PluginActionResult>;
  readonly webProviders: () => readonly WebProviderChoice[];
  readonly currentWebProvider: () => string | undefined;
  readonly setWebProvider: (id: string | undefined) => Promise<void>;
  /**
   * Session cwd (`config.cwd`, not `process.cwd()` — `--cwd` does not chdir).
   * Disk-confirm and ownership checks must use this, never `process.cwd()`.
   */
  readonly cwd: string;
  /** Home used for user-plugin / ~/.claude ownership checks. */
  readonly home: string;
  /**
   * Standing session-level load warnings (or the full set when attribution is
   * weak). Shown as a summary row under `/plugins`; drives `plugin !` via the
   * runner, not this surface.
   */
  readonly loadWarnings?: () => readonly string[];
}

/** Discovered lifecycle hook, live enablement, and enough to describe what it runs. */
export interface HookEntry {
  readonly id: string;
  readonly name: string;
  readonly type: "typescript" | "shell";
  readonly path: string;
  readonly enabled: boolean;
  /** What the hook fires on, from a cheap static check — see runner wiring. */
  readonly runsOn: string;
}

export interface HooksSurfaceDeps {
  readonly list: () => readonly HookEntry[];
  readonly setEnabled: (id: string, enabled: boolean) => Promise<void>;
}

/** A configured MCP server and its live connection state. */
export interface McpEntry {
  readonly name: string;
  readonly state: "connecting" | "connected" | "needs-auth" | "failed";
  /** Tool count once connected. */
  readonly toolCount?: number;
  /** Authorization URL while `needs-auth`. */
  readonly authURL?: string;
  /** Failure reason while `failed`. */
  readonly error?: string;
}

export interface McpSurfaceDeps {
  readonly list: () => readonly McpEntry[];
  /** Open the server's authorization URL in the operator's browser. */
  readonly openAuthURL: (url: string) => void;
  readonly subscribe?: (listener: () => void) => () => void;
  readonly addServer?: (name: string, url: string) => Promise<PluginActionResult>;
  /** Reconnect a failed persisted server without writing a second settings row. */
  readonly retryServer?: (name: string) => Promise<PluginActionResult>;
  readonly mcpServersSource?: "local" | "global" | "none";
}

/** Live summary for the settings surface's hooks row (owned by another surface). */
export interface HooksSurfaceSummary {
  readonly discovered: number;
  readonly off: number;
}

export interface SettingsSurfaceDeps {
  readonly read: () => SettingsSnapshot;
  readonly setCompactionMode: (mode: CompactionMode) => void;
  readonly setWaitForApproval: (value: boolean) => void;
  readonly setTelemetryEnabled: (value: boolean) => void;
  readonly setShowPromptCost: (value: boolean) => void;
  /** Live counts for the hooks row summary. Omitted while hooks discovery is unbuilt. */
  readonly hooksSummary?: () => HooksSurfaceSummary;
  /** Opens the hooks surface. Omitted while it is unbuilt (row still shows, Enter no-ops). */
  readonly openHooks?: () => void;
}

export interface CommandSurfaceDeps {
  readonly permissions?: PermissionsSurfaceDeps;
  readonly plugins?: PluginsSurfaceDeps;
  readonly hooks?: HooksSurfaceDeps;
  readonly mcp?: McpSurfaceDeps;
  readonly settings?: SettingsSurfaceDeps;
  /** Opens the host's model/provider picker (owned by the product host). */
  readonly openModels?: () => void;
  /** Opens the host's add-provider selector (owned by the product host). `/connect` omits returnToModels. */
  readonly openAddProvider?: (opts?: { returnToModels?: boolean }) => void;
  /** Fallback channel for surfaces with no live data source. */
  readonly notify: (text: string) => void;
}

/** Surface a command result can ask for. */
export type CommandSurfaceKind =
  "help" | "settings" | "permissions" | "plugins" | "hooks" | "mcp" | "models" | "add-provider";

const CLOSE_ID = "__close__";
const ADD_MCP_ID = "__add_mcp__";
const EMPTY_MCP_ID = "__empty_mcp__";
const BACK_ID = "__back__";
/** Synthetic `/plugins` row for standing load warnings (not a plugin id). */
const PLUGIN_LOAD_WARNINGS_ID = "__plugin_load_warnings__";
const REMOVE_CONFIRM_ID = "__remove_confirm__";
const REMOVE_CANCEL_ID = "__remove_cancel__";

export function grantRowLabel(entry: GrantEntry): string {
  const suffix = entry.providerModel !== undefined ? ` (${entry.providerModel})` : "";
  return `${entry.scopeLabel} · ${entry.tool} ${entry.pattern}${suffix}`;
}

function pluginMissingCredential(entry: PluginEntry): boolean {
  return entry.credentials.some((f) => (entry.credentialValues[f.key] ?? "").length === 0);
}

function pluginHasWarnings(entry: PluginEntry): boolean {
  return (entry.warnings?.length ?? 0) > 0;
}

export function pluginRowLabel(entry: PluginEntry): string {
  const state = entry.needsTrust === true ? "untrusted" : entry.enabled ? "enabled" : "disabled";
  const blocker =
    entry.needsTrust !== true && !entry.enabled && pluginMissingCredential(entry)
      ? "needs api key"
      : pluginHasWarnings(entry)
        ? "has warnings"
        : entry.kind;
  return blocker ? `${entry.name} — ${state} — ${blocker}` : `${entry.name} — ${state}`;
}

function pluginNeedsDiskConfirm(entry: PluginEntry, plugins: PluginsSurfaceDeps): boolean {
  return (
    classifyPluginRemove({
      origin: entry.origin,
      owned: isOwnedDiskInstall({
        origin: entry.origin,
        ...(entry.pluginPath !== undefined ? { pluginPath: entry.pluginPath } : {}),
        home: plugins.home,
        cwd: plugins.cwd,
      }),
    }) === "delete-owned"
  );
}

function pluginRemoveHint(entry: PluginEntry, plugins: PluginsSurfaceDeps): string {
  if (entry.origin === "repo") {
    return "Bundled with Corbits Code — Alt+X disables it; it cannot be uninstalled.";
  }
  if (pluginNeedsDiskConfirm(entry, plugins)) {
    return "Alt+X removes this plugin from disk after confirmation.";
  }
  if (entry.origin === "path") {
    return "Alt+X removes this path plugin from the session and settings.";
  }
  if (entry.origin === "user" && entry.source === "claude") {
    return "Alt+X disables this Claude marketplace plugin without deleting ~/.claude.";
  }
  return "Alt+X removes this plugin.";
}

/** Description-zone content for the focused plugin row. */
export function pluginDescription(
  entry: PluginEntry,
  plugins: PluginsSurfaceDeps,
): ItemDescription {
  const what = entry.description ?? `${entry.kind ?? "plugin"} plugin.`;
  if (entry.needsTrust === true) {
    const where =
      entry.originPath !== undefined
        ? `Loaded from ${entry.originPath} — outside this workspace. `
        : "";
    return {
      what,
      impact: `${where}Trusting it runs its code in this session. Press Alt+T.`,
      tone: "consequence",
    };
  }
  if (!entry.enabled && pluginMissingCredential(entry)) {
    return { what, impact: "Needs an API key before it can be enabled — press Alt+C." };
  }
  if (pluginHasWarnings(entry) && entry.warnings !== undefined) {
    const summary = formatPluginWarningsSummary(entry.warnings) ?? entry.warnings.join("; ");
    return { what, impact: summary, tone: "consequence" };
  }
  return { what, impact: pluginRemoveHint(entry, plugins) };
}

function payload(entries: readonly ResidualCatalogEntry[]): {
  items: readonly string[];
  itemIds: readonly string[];
} {
  return { items: entries.map((e) => e.label), itemIds: entries.map((e) => e.id) };
}

function selectedId(
  selection: OverlaySelection,
  entries: readonly ResidualCatalogEntry[],
): string | undefined {
  return residualIdFromSelection(
    selection,
    entries.map((e) => e.id),
  );
}

/** One option in a cycled field, as drawn inline: `label` bracketed when active. */
interface CycleOption<T extends string> {
  readonly id: T;
  readonly label: string;
}

/** Render a cycled field's current state: `label  ‹ label ›  label`. */
function cycleField<T extends string>(options: readonly CycleOption<T>[], activeId: T): string {
  return options.map((o) => (o.id === activeId ? `‹ ${o.label} ›` : o.label)).join("  ");
}

/** Step `current` to the next/previous option in `options`, wrapping. */
function cycleValue<T>(options: readonly T[], current: T, direction: -1 | 1): T {
  const idx = options.indexOf(current);
  const base = idx < 0 ? 0 : idx;
  const next = options[(base + direction + options.length) % options.length];
  return next ?? current;
}

/** The active option's plain label — the value an accept echo should report, not the row's painted display string. */
function activeOptionLabel<T extends string>(
  options: readonly CycleOption<T>[],
  activeId: T,
): string {
  return options.find((o) => o.id === activeId)?.label ?? activeId;
}

const COMPACTION_OPTIONS: readonly CycleOption<CompactionMode>[] = [
  { id: "llm", label: "summarize" },
  { id: "pruning", label: "drop" },
];
const ON_OFF_OPTIONS: readonly CycleOption<"on" | "off">[] = [
  { id: "on", label: "on" },
  { id: "off", label: "off" },
];
const SETTINGS_NAME_WIDTH = 16;

/** One inline-cycled settings row: label, live value, description, and its cycle step. */
interface SettingsCycleRow {
  readonly id: string;
  readonly value: string;
  /** Plain value the row currently holds, for the accept echo — not the painted `value` string. */
  readonly chosenLabel: string;
  readonly describe: ItemDescription;
  readonly cycle: (direction: -1 | 1) => void;
}

/** Cycled rows shown above the divider, in mockup order. */
function settingsCycleRows(
  snapshot: SettingsSnapshot,
  settings: SettingsSurfaceDeps,
): readonly SettingsCycleRow[] {
  return [
    {
      id: "compaction",
      value: `${"compaction".padEnd(SETTINGS_NAME_WIDTH)}${cycleField(COMPACTION_OPTIONS, snapshot.compactionMode)}`,
      chosenLabel: activeOptionLabel(COMPACTION_OPTIONS, snapshot.compactionMode),
      describe: {
        what: "how the transcript is trimmed once the context fills.",
        impact: "summarize (default) costs a call; drop is free but strips output too.",
        tone: "consequence",
      },
      cycle: (dir) =>
        settings.setCompactionMode(
          cycleValue(
            COMPACTION_OPTIONS.map((o) => o.id),
            snapshot.compactionMode,
            dir,
          ),
        ),
    },
    {
      id: "wait-for-approval",
      value: `${"approval wait".padEnd(SETTINGS_NAME_WIDTH)}${cycleField(ON_OFF_OPTIONS, snapshot.waitForApproval ? "on" : "off")}`,
      chosenLabel: activeOptionLabel(ON_OFF_OPTIONS, snapshot.waitForApproval ? "on" : "off"),
      describe: {
        what: "whether a tool's time budget pauses while waiting on your approval.",
        impact:
          "off counts the wait against the tool's timeout, so a slow approval can time it out.",
        tone: "consequence",
      },
      cycle: () => settings.setWaitForApproval(!snapshot.waitForApproval),
    },
    {
      id: "telemetry",
      value: `${"telemetry".padEnd(SETTINGS_NAME_WIDTH)}${cycleField(ON_OFF_OPTIONS, snapshot.telemetryEnabled ? "on" : "off")}`,
      chosenLabel: activeOptionLabel(ON_OFF_OPTIONS, snapshot.telemetryEnabled ? "on" : "off"),
      describe: {
        what: "anonymous ambient usage data (product events and AI traces). Free text only leaves via /feedback if you send it.",
        impact:
          "off stops ambient telemetry for this session. /feedback still works unless DO_NOT_TRACK or CORBITS_TELEMETRY=0 is set.",
        tone: "consequence",
      },
      cycle: () => settings.setTelemetryEnabled(!snapshot.telemetryEnabled),
    },
    {
      id: "prompt-cost",
      value: `${"show cost".padEnd(SETTINGS_NAME_WIDTH)}${cycleField(ON_OFF_OPTIONS, snapshot.showPromptCost ? "on" : "off")}`,
      chosenLabel: activeOptionLabel(ON_OFF_OPTIONS, snapshot.showPromptCost ? "on" : "off"),
      describe: {
        what: "shows the session's spend in the prompt border, next to the context percentage.",
        impact:
          "it's a running total that draws the eye every time it changes — off by default; /cost still gives the full breakdown on demand.",
      },
      cycle: () => settings.setShowPromptCost(!snapshot.showPromptCost),
    },
  ];
}

/** One navigation row: opens a full sub-surface instead of cycling in place. */
interface SettingsNavRow {
  readonly id: string;
  readonly value: string;
  readonly describe: ItemDescription;
}

/**
 * Nav rows other than permissions, which is the only one with an async source
 * (`permissions.list()`). Plugins and hooks read synchronously, so keeping
 * them out of a promise chain means a settings open with no permissions dep
 * paints in the same tick it was requested — callers that open and immediately
 * assert on `shell.overlayKind` depend on that.
 */
function settingsSyncNavRows(deps: CommandSurfaceDeps): SettingsNavRow[] {
  const rows: SettingsNavRow[] = [];
  if (deps.plugins) {
    const entries = deps.plugins.list();
    const enabled = entries.filter((e) => e.enabled).length;
    const needsKey = entries.filter((e) => e.needsTrust === true).length;
    const suffix = needsKey > 0 ? ` · ${needsKey} needs a key` : "";
    rows.push({
      id: "plugins",
      value: `${"plugins".padEnd(SETTINGS_NAME_WIDTH)}${enabled} enabled${suffix}`,
      describe: {
        what: "discovered plugins and whether each is enabled.",
        impact: "disabling a plugin removes its tools and commands immediately.",
        tone: "consequence",
      },
    });
  }
  if (deps.settings?.hooksSummary) {
    const summary = deps.settings.hooksSummary();
    const suffix = summary.off > 0 ? ` · ${summary.off} off` : "";
    rows.push({
      id: "hooks",
      value: `${"hooks".padEnd(SETTINGS_NAME_WIDTH)}${summary.discovered} discovered${suffix}`,
      describe: {
        what: "lifecycle hooks discovered for this session.",
        impact: "a hook that is off does not run, even when its trigger fires.",
      },
    });
  }
  return rows;
}

function permissionsNavRow(count: number): SettingsNavRow {
  return {
    id: "permissions",
    value: `${"permissions".padEnd(SETTINGS_NAME_WIDTH)}${count} remembered`,
    describe: {
      what: "remembered tool approvals from earlier in this session.",
      impact: "revoking one means the next matching tool call asks again.",
    },
  };
}

/** Render the menu from a fully-resolved row set — the part every open path shares. */
function renderSettingsMenu(
  shell: AppShell,
  deps: CommandSurfaceDeps,
  settings: SettingsSurfaceDeps,
  navRows: readonly SettingsNavRow[],
): void {
  // Cycling re-enters openSettingsSurface to refresh every row's closures
  // against the just-written value; closing first forces a real reopen (a
  // second open of the same primary kind while one is showing is a no-op)
  // while the captured index keeps the cursor where the operator left it.
  const activeIndex = shell.overlayList?.activeIndex ?? 0;
  closeInsetOverlay(shell);
  const snapshot = settings.read();
  const cycleRows = settingsCycleRows(snapshot, settings);
  const byId = new Map<string, SettingsCycleRow>(cycleRows.map((r) => [r.id, r]));
  const descById = new Map<string, ItemDescription>([
    ...cycleRows.map((r) => [r.id, r.describe] as const),
    ...navRows.map((r) => [r.id, r.describe] as const),
  ]);
  const ids = [...cycleRows.map((r) => r.id), ...navRows.map((r) => r.id)];
  const items = [...cycleRows.map((r) => r.value), ...navRows.map((r) => r.value)];
  // Nav rows (permissions, plugins, hooks) open a sub-surface rather than
  // holding a value of their own, so they carry no echo value.
  const values: readonly (string | undefined)[] = [
    ...cycleRows.map((r) => r.chosenLabel),
    ...navRows.map(() => undefined),
  ];

  openSettingsOverlay(shell, {
    items,
    itemIds: ids,
    itemValues: values,
    activeIndex: Math.min(activeIndex, Math.max(0, items.length - 1)),
    describe: (id) => descById.get(id) ?? null,
    onCycle: (id, direction) => {
      const row = byId.get(id);
      if (!row) return;
      row.cycle(direction);
      openSettingsSurface(shell, deps);
    },
    onAccept: (selection) => {
      const id = residualIdFromSelection(selection, ids);
      switch (id) {
        case "permissions":
          openPermissionsSurface(shell, deps);
          return;
        case "plugins":
          openPluginsSurface(shell, deps);
          return;
        case "hooks":
          if (deps.settings?.openHooks) {
            deps.settings.openHooks();
            return;
          }
          deps.notify("Hooks administration is not available in this session.");
          openSettingsSurface(shell, deps);
          return;
        default:
          return;
      }
    },
  });
}

/**
 * Settings menu, re-opened after every change so values stay current.
 *
 * Permissions is the only nav row with an async source; without that dep the
 * whole open resolves synchronously, so a caller that opens and immediately
 * inspects the shell (no permissions admin wired) sees it painted.
 */
export function openSettingsSurface(shell: AppShell, deps: CommandSurfaceDeps): void {
  const settings = deps.settings;
  if (settings === undefined) {
    deps.notify("Settings are not available in this session.");
    return;
  }
  if (deps.permissions === undefined) {
    renderSettingsMenu(shell, deps, settings, settingsSyncNavRows(deps));
    return;
  }
  void deps.permissions.list().then((entries) => {
    renderSettingsMenu(shell, deps, settings, [
      permissionsNavRow(entries.length),
      ...settingsSyncNavRows(deps),
    ]);
  });
}

/** Remembered approvals; Enter revokes the highlighted grant. */
export function openPermissionsSurface(shell: AppShell, deps: CommandSurfaceDeps): void {
  const permissions = deps.permissions;
  if (permissions === undefined) {
    deps.notify("Permission administration is not available in this session.");
    return;
  }
  void permissions.list().then(
    (entries) => {
      closeInsetOverlay(shell);
      const rows: ResidualCatalogEntry[] = entries.map((e) => ({
        id: e.id,
        label: grantRowLabel(e),
      }));
      if (rows.length === 0) {
        rows.push({
          id: CLOSE_ID,
          label: "No remembered approvals — grants you accept appear here",
        });
      }
      rows.push({ id: BACK_ID, label: "Back to settings" });
      openListOverlay(shell, {
        kind: "permissions",
        title: "permissions · Enter revokes",
        frameId: "overlay-permissions",
        ...payload(rows),
        onAccept: (selection) => {
          const id = selectedId(selection, rows);
          if (id === undefined || id === CLOSE_ID) return;
          if (id === BACK_ID) {
            openSettingsSurface(shell, deps);
            return;
          }
          void permissions.revoke(id).then(
            () => openPermissionsSurface(shell, deps),
            (err: unknown) => deps.notify(`Revoke failed: ${errorText(err)}`),
          );
        },
      });
    },
    (err: unknown) => deps.notify(`Could not read remembered approvals: ${errorText(err)}`),
  );
}

/** Live edit state for the open credentials pane. */
interface CredentialPaneState {
  values: Record<string, string>;
  editing: number | null;
  buffer: string;
}

/** Bullet-render a field's row label: masked live echo while editing, saved summary otherwise. */
function credentialRowLabel(
  field: PluginCredentialFieldEntry,
  saved: string,
  isEditing: boolean,
  buffer: string,
): string {
  if (isEditing) {
    const shown = field.secret === true ? maskEcho(buffer) : buffer;
    return `${field.label}: ${shown}▏`;
  }
  if (saved.length === 0) return `${field.label}: (unset)`;
  return `${field.label}: ${field.secret === true ? maskSecret(saved) : saved}`;
}

/**
 * Credential entry pane for one plugin. Enter starts/commits an inline edit;
 * s saves; v saves then verifies. A secret field is never echoed in the
 * clear — the buffer is displayed only through `maskEcho`/`maskSecret`, and
 * every keystroke mutates the real value directly (append/backspace), so
 * there is no masked-display round-trip to get wrong.
 */
function openCredentialsPane(
  shell: AppShell,
  deps: CommandSurfaceDeps,
  plugins: PluginsSurfaceDeps,
  entry: PluginEntry,
  state: CredentialPaneState,
): void {
  closeInsetOverlay(shell);
  const fields = entry.credentials;
  const rows: ResidualCatalogEntry[] = fields.map((f, i) => ({
    id: f.key,
    label: credentialRowLabel(f, state.values[f.key] ?? "", state.editing === i, state.buffer),
  }));
  rows.push({ id: BACK_ID, label: "Back to plugin" });
  openListOverlay(shell, {
    kind: "plugin_credentials",
    title: `${entry.name} · credentials`,
    frameId: "overlay-plugin-credentials",
    activeIndex: Math.min(state.editing ?? 0, rows.length - 1),
    ...payload(rows),
    describe: (id) => {
      if (id === BACK_ID) return { what: "Return to the plugin row." };
      const field = fields.find((f) => f.key === id);
      if (field === undefined) return null;
      return {
        what: field.description ?? field.label,
        impact: "Enter edits this field. s saves. v saves then verifies.",
      };
    },
    onAccept: (selection) => {
      const id = selectedId(selection, rows);
      if (id === undefined || id === BACK_ID) {
        openPluginsSurface(shell, deps);
        return;
      }
      const idx = fields.findIndex((f) => f.key === id);
      if (idx < 0) return;
      if (state.editing === idx) {
        state.values = { ...state.values, [id]: state.buffer };
        state.editing = null;
        state.buffer = "";
      } else {
        state.editing = idx;
        state.buffer = state.values[id] ?? "";
      }
      openCredentialsPane(shell, deps, plugins, entry, state);
    },
    onAction: (_id, key) => {
      if (state.editing === null) {
        if (key.ctrl || key.meta || key.option) return false;
        if (key.name === "s") {
          void Promise.resolve(plugins.saveCredentials(entry.id, state.values)).then(
            () => deps.notify(`Saved credentials for ${entry.name}.`),
            (err: unknown) => deps.notify(`Save failed: ${errorText(err)}`),
          );
          return true;
        }
        if (key.name === "v") {
          void Promise.resolve(plugins.saveCredentials(entry.id, state.values))
            .then(() => plugins.verify(entry.id, state.values))
            .then(
              (result) =>
                deps.notify(`${entry.name}: ${result.ok ? "ok" : "failed"} — ${result.message}`),
              (err: unknown) => deps.notify(`Verify failed: ${errorText(err)}`),
            );
          return true;
        }
        return false;
      }
      if (key.name === "backspace") {
        state.buffer = state.buffer.slice(0, -1);
        openCredentialsPane(shell, deps, plugins, entry, state);
        return true;
      }
      const seq = typeof key.sequence === "string" ? key.sequence : "";
      if (seq.length === 1 && seq >= " " && !key.ctrl && !key.meta && !key.option) {
        state.buffer += seq;
        openCredentialsPane(shell, deps, plugins, entry, state);
        return true;
      }
      return false;
    },
  });
}

/** Single-field free-text prompt, used for "add plugin by path". */
function openTextPromptPane(
  shell: AppShell,
  opts: {
    readonly title: string;
    readonly what: string;
    readonly onSubmit: (value: string) => void;
  },
  buffer: { value: string },
): void {
  closeInsetOverlay(shell);
  openListOverlay(shell, {
    kind: "plugin_credentials",
    title: opts.title,
    frameId: "overlay-plugin-textprompt",
    items: [buffer.value.length === 0 ? "▏" : `${buffer.value}▏`],
    itemIds: ["value"],
    describe: () => ({ what: opts.what, impact: "Enter accepts. Esc cancels." }),
    onAccept: () => opts.onSubmit(buffer.value.trim()),
    onPaste: (text) => {
      buffer.value += text;
      openTextPromptPane(shell, opts, buffer);
    },
    onAction: (_id, key) => {
      if (key.ctrl || key.meta || key.option) return false;
      if (key.name === "backspace") {
        buffer.value = buffer.value.slice(0, -1);
        openTextPromptPane(shell, opts, buffer);
        return true;
      }
      const seq = typeof key.sequence === "string" ? key.sequence : "";
      if (seq.length === 1 && seq >= " ") {
        buffer.value += seq;
        openTextPromptPane(shell, opts, buffer);
        return true;
      }
      return false;
    },
  });
}

function openAddPathPane(
  shell: AppShell,
  deps: CommandSurfaceDeps,
  plugins: PluginsSurfaceDeps,
): void {
  openTextPromptPane(
    shell,
    {
      title: "add plugin by path",
      what: "Absolute or relative path to a plugin file or directory.",
      onSubmit: (path) => {
        if (path.length === 0) {
          deps.notify("Enter a path first.");
          return;
        }
        void plugins.addPath(path).then(
          (result) => {
            deps.notify(result.message);
            openPluginsSurface(shell, deps);
          },
          (err: unknown) => deps.notify(`Add failed: ${errorText(err)}`),
        );
      },
    },
    { value: "" },
  );
}

function applyPluginRemove(
  shell: AppShell,
  deps: CommandSurfaceDeps,
  plugins: PluginsSurfaceDeps,
  entry: PluginEntry,
): void {
  void plugins.remove(entry.id).then(
    (result) => {
      deps.notify(result.message);
      openPluginsSurface(shell, deps);
    },
    (err: unknown) => deps.notify(`Remove failed: ${errorText(err)}`),
  );
}

function openRemoveConfirmPane(
  shell: AppShell,
  deps: CommandSurfaceDeps,
  plugins: PluginsSurfaceDeps,
  entry: PluginEntry,
): void {
  closeInsetOverlay(shell);
  const rows: ResidualCatalogEntry[] = [
    { id: REMOVE_CONFIRM_ID, label: `Remove ${entry.name} from disk` },
    { id: REMOVE_CANCEL_ID, label: "Cancel" },
  ];
  openListOverlay(shell, {
    kind: "plugin_credentials",
    title: "remove plugin",
    frameId: "overlay-plugin-remove",
    ...payload(rows),
    describe: (id) => {
      if (id === REMOVE_CANCEL_ID) return { what: "Return to the plugin list." };
      return {
        what: `Delete ${entry.name} from disk and disable it in settings.`,
        impact: "This cannot be undone.",
        tone: "consequence",
      };
    },
    onCancel: () => openPluginsSurface(shell, deps),
    onAccept: (selection) => {
      const id = selectedId(selection, rows);
      if (id === undefined || id === REMOVE_CANCEL_ID) {
        openPluginsSurface(shell, deps);
        return;
      }
      applyPluginRemove(shell, deps, plugins, entry);
    },
  });
}

function openWebProviderChooser(
  shell: AppShell,
  deps: CommandSurfaceDeps,
  plugins: PluginsSurfaceDeps,
): void {
  closeInsetOverlay(shell);
  const providers = plugins.webProviders();
  const current = plugins.currentWebProvider();
  const AUTO_ID = "__auto__";
  const rows: ResidualCatalogEntry[] = [
    { id: AUTO_ID, label: current === undefined ? "‹ automatic ›" : "automatic" },
    ...providers.map((p) => ({ id: p.id, label: p.id === current ? `‹ ${p.name} ›` : p.name })),
    { id: BACK_ID, label: "Back to plugins" },
  ];
  openListOverlay(shell, {
    kind: "plugin_credentials",
    title: "web search provider",
    frameId: "overlay-plugin-web",
    ...payload(rows),
    onAccept: (selection) => {
      const id = selectedId(selection, rows);
      if (id === undefined || id === BACK_ID) {
        openPluginsSurface(shell, deps);
        return;
      }
      const chosen = id === AUTO_ID ? undefined : id;
      void Promise.resolve(plugins.setWebProvider(chosen)).then(
        () => openPluginsSurface(shell, deps),
        (err: unknown) => deps.notify(`Set provider failed: ${errorText(err)}`),
      );
    },
  });
}

/**
 * Discovered plugins. Enter toggles enablement (blocked pre-trust); Alt+C
 * opens credentials, Alt+V verifies, Alt+T trusts, Alt+A adds by path,
 * Alt+X removes, Alt+W picks the web provider.
 */
export function openPluginsSurface(shell: AppShell, deps: CommandSurfaceDeps): void {
  const plugins = deps.plugins;
  if (plugins === undefined) {
    deps.notify("Plugin administration is not available in this session.");
    return;
  }
  closeInsetOverlay(shell);
  const entries = plugins.list();
  const rows: ResidualCatalogEntry[] = entries.map((e) => ({
    id: e.id,
    label: pluginRowLabel(e),
  }));
  const loadWarnings = plugins.loadWarnings?.() ?? [];
  const loadSummary = formatPluginWarningsSummary(loadWarnings);
  if (loadSummary !== undefined) {
    rows.unshift({
      id: PLUGIN_LOAD_WARNINGS_ID,
      label: loadSummary.replace(/^plugins:\s*/, ""),
    });
  }
  if (rows.length === 0) {
    rows.push({ id: CLOSE_ID, label: "No plugins discovered" });
  }
  rows.push({ id: CLOSE_ID, label: "Close plugins" });
  const byId = new Map(entries.map((e) => [e.id, e]));
  openListOverlay(shell, {
    kind: "plugins",
    title: "plugins",
    frameId: "overlay-plugins",
    ...payload(rows),
    describe: (id) => {
      if (id === PLUGIN_LOAD_WARNINGS_ID) {
        return {
          what: loadSummary ?? "Plugin load warnings.",
          impact:
            "Standing diagnostics from plugin discovery and load. Fix the named skills or plugins, then relaunch.",
          tone: "consequence",
        };
      }
      const target = byId.get(id);
      return target === undefined ? null : pluginDescription(target, plugins);
    },
    onAccept: (selection) => {
      const id = selectedId(selection, rows);
      if (id === undefined || id === CLOSE_ID || id === PLUGIN_LOAD_WARNINGS_ID) return;
      const target = byId.get(id);
      if (target === undefined) return;
      if (target.needsTrust === true) {
        deps.notify(`${target.name} is untrusted — press Alt+T to trust it before enabling.`);
        openPluginsSurface(shell, deps);
        return;
      }
      void Promise.resolve(plugins.setEnabled(target.id, !target.enabled)).then(
        (result) => {
          if (result?.message !== undefined) deps.notify(result.message);
          openPluginsSurface(shell, deps);
        },
        (err: unknown) => deps.notify(`Plugin update failed: ${errorText(err)}`),
      );
    },
    onAction: (id, key) => {
      // Alt+<key>, never bare — c/v/t/a/w/x read as ordinary letters the
      // filter-as-you-type list would otherwise swallow. Alt+C never
      // collides with the global copy-mode chord: this surface's overlay
      // branch returns before that handler is reached (see shell.ts's
      // top-level onKey), so exactly one of the two can ever fire.
      if (key.ctrl || !(key.meta || key.option)) return false;
      const name = typeof key.name === "string" ? key.name.toLowerCase() : "";
      // Surface-level chords — advertised in the how-to even when focus is on
      // Close, the empty-list row, or load warnings.
      if (name === "a") {
        openAddPathPane(shell, deps, plugins);
        return true;
      }
      if (name === "w") {
        openWebProviderChooser(shell, deps, plugins);
        return true;
      }
      if (id === PLUGIN_LOAD_WARNINGS_ID) return false;
      const target = byId.get(id);
      if (target === undefined) return false;
      switch (name) {
        case "c":
          if (target.credentials.length === 0) return false;
          openCredentialsPane(shell, deps, plugins, target, {
            values: { ...target.credentialValues },
            editing: null,
            buffer: "",
          });
          return true;
        case "v":
          void plugins.verify(target.id, { ...target.credentialValues }).then(
            (result) =>
              deps.notify(`${target.name}: ${result.ok ? "ok" : "failed"} — ${result.message}`),
            (err: unknown) => deps.notify(`Verify failed: ${errorText(err)}`),
          );
          return true;
        case "t":
          if (target.needsTrust !== true) return false;
          void Promise.resolve(plugins.setEnabled(target.id, true)).then(
            (result) => {
              if (result?.message !== undefined) deps.notify(result.message);
              openPluginsSurface(shell, deps);
            },
            (err: unknown) => deps.notify(`Trust failed: ${errorText(err)}`),
          );
          return true;
        case "x":
          if (pluginNeedsDiskConfirm(target, plugins)) {
            openRemoveConfirmPane(shell, deps, plugins, target);
          } else {
            applyPluginRemove(shell, deps, plugins, target);
          }
          return true;
        default:
          return false;
      }
    },
  });
}

function hookRowLabel(entry: HookEntry): string {
  return `${entry.name} — ${entry.enabled ? "enabled" : "disabled"}`;
}

/** Discovered lifecycle hooks; Enter toggles enablement. */
export function openHooksSurface(shell: AppShell, deps: CommandSurfaceDeps): void {
  const hooks = deps.hooks;
  if (hooks === undefined) {
    deps.notify("Hook administration is not available in this session.");
    return;
  }
  closeInsetOverlay(shell);
  const entries = hooks.list();
  const rows: ResidualCatalogEntry[] = entries.map((e) => ({ id: e.id, label: hookRowLabel(e) }));
  if (rows.length === 0) {
    rows.push({ id: CLOSE_ID, label: "No hooks discovered" });
  }
  rows.push({ id: CLOSE_ID, label: "Close hooks" });
  const byId = new Map(entries.map((e) => [e.id, e]));
  openListOverlay(shell, {
    kind: "hooks",
    title: "hooks",
    frameId: "overlay-hooks",
    ...payload(rows),
    describe: (id) => {
      const target = byId.get(id);
      if (target === undefined) return null;
      return {
        what: `${target.runsOn} — ${target.path}`,
        impact: target.enabled ? "Enter turns this hook off." : "Enter turns this hook on.",
      };
    },
    onAccept: (selection) => {
      const id = selectedId(selection, rows);
      if (id === undefined || id === CLOSE_ID) return;
      const target = byId.get(id);
      if (target === undefined) return;
      void Promise.resolve(hooks.setEnabled(target.id, !target.enabled)).then(
        () => openHooksSurface(shell, deps),
        (err: unknown) => deps.notify(`Hook update failed: ${errorText(err)}`),
      );
    },
  });
}

export function mcpRowLabel(entry: McpEntry): string {
  switch (entry.state) {
    case "connecting":
      return `${entry.name} — connecting`;
    case "connected": {
      const n = entry.toolCount ?? 0;
      return `${entry.name} — connected · ${n} tool${n === 1 ? "" : "s"}`;
    }
    case "needs-auth":
      return `${entry.name} — needs auth`;
    case "failed":
      return `${entry.name} — failed`;
  }
}

function mcpDescription(entry: McpEntry): ItemDescription {
  switch (entry.state) {
    case "connecting":
      return { what: "Connecting — its tools are not dispatchable yet." };
    case "connected":
      return { what: "Connected. Its tools are reachable through tool_search." };
    case "needs-auth":
      return {
        what: "Authorization has not completed, so this server contributes no tools.",
        impact: "Enter opens the authorization page and copies the link.",
      };
    case "failed":
      return {
        what: entry.error ?? "Did not connect.",
        impact: "Enter retries the existing persisted config without adding a second server.",
        tone: "consequence",
      };
  }
}

function canAddMCPServer(mcp: McpSurfaceDeps): boolean {
  return mcp.mcpServersSource !== "local";
}

function runMcpSurfaceAction(
  shell: AppShell,
  deps: CommandSurfaceDeps,
  action: Promise<PluginActionResult>,
  failPrefix: string,
): void {
  const continuation = captureOverlayContinuation(shell);
  void action
    .then(
      (result) => {
        if (!isOverlayContinuationCurrent(shell, continuation)) return;
        deps.notify(result.message);
        if (isOverlayContinuationCurrent(shell, continuation)) openMcpSurface(shell, deps);
      },
      (err: unknown) => {
        if (!isOverlayContinuationCurrent(shell, continuation)) return;
        deps.notify(`${failPrefix}: ${errorText(err)}`);
      },
    )
    .catch(() => {
      // UI continuation failures must not escape a fire-and-forget command.
    });
}

function mcpSurfaceRows(entries: readonly McpEntry[], canAdd: boolean): ResidualCatalogEntry[] {
  const rows: ResidualCatalogEntry[] = entries.map((e) => ({
    id: e.name,
    label: mcpRowLabel(e),
  }));
  if (rows.length === 0) rows.push({ id: EMPTY_MCP_ID, label: "No MCP servers configured" });
  if (canAdd) rows.push({ id: ADD_MCP_ID, label: "Add MCP server — Alt+A" });
  rows.push({ id: CLOSE_ID, label: "Close mcp" });
  return rows;
}

function openAddMcpURLPane(
  shell: AppShell,
  deps: CommandSurfaceDeps,
  mcp: McpSurfaceDeps,
  name: string,
  buffer = { value: "" },
): void {
  openTextPromptPane(
    shell,
    {
      title: `add ${name} MCP URL`,
      what: "Absolute HTTP(S) URL for the MCP server.",
      onSubmit: (url) => {
        if (!isAbsoluteHTTPURL(url)) {
          deps.notify("Enter an absolute HTTP(S) URL first.");
          openAddMcpURLPane(shell, deps, mcp, name, buffer);
          return;
        }
        const addServer = mcp.addServer;
        if (addServer === undefined) {
          deps.notify("Adding MCP servers is not available in this session.");
          return;
        }
        runMcpSurfaceAction(shell, deps, addServer(name, url), "Add failed");
      },
    },
    buffer,
  );
}

function openAddMcpNamePane(
  shell: AppShell,
  deps: CommandSurfaceDeps,
  mcp: McpSurfaceDeps,
  buffer = { value: "" },
): void {
  openTextPromptPane(
    shell,
    {
      title: "add MCP server",
      what: "Unique name using letters, numbers, single underscores, or hyphens.",
      onSubmit: (name) => {
        const validationError = validateMCPServerName(name);
        if (validationError !== null) {
          deps.notify(validationError);
          openAddMcpNamePane(shell, deps, mcp, buffer);
          return;
        }
        openAddMcpURLPane(shell, deps, mcp, name);
      },
    },
    buffer,
  );
}

/** Configured MCP servers and their live state; Enter authorizes or retries. */
export function openMcpSurface(
  shell: AppShell,
  deps: CommandSurfaceDeps,
  activeName?: string,
): void {
  const mcp = deps.mcp;
  if (mcp === undefined) {
    deps.notify("MCP administration is not available in this session.");
    return;
  }
  closeInsetOverlay(shell);
  const entries = mcp.list();
  const canAdd = canAddMCPServer(mcp);
  const rows: ResidualCatalogEntry[] = mcpSurfaceRows(entries, canAdd);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const activeIndex =
    activeName === undefined ? -1 : rows.findIndex((row) => row.id === activeName);
  let unsubscribe: () => void = () => undefined;
  openListOverlay(shell, {
    kind: "mcp",
    ...(activeIndex >= 0 ? { activeIndex } : {}),
    title: "mcp",
    frameId: "overlay-mcp",
    // The flash below reports the outcome; the echo would quote the row's
    // pre-authorization label back at the operator forever.
    echoChoice: false,
    ...payload(rows),
    describe: (id) => {
      const target = byName.get(id);
      return target === undefined ? null : mcpDescription(target);
    },
    onCancel: () => unsubscribe(),
    onAccept: (selection) => {
      const id = selectedId(selection, rows);
      unsubscribe();
      if (id === undefined || id === CLOSE_ID || id === EMPTY_MCP_ID) return;
      if (id === ADD_MCP_ID) {
        if (!canAdd) return;
        openAddMcpNamePane(shell, deps, mcp);
        return;
      }
      const target = byName.get(id);
      if (target === undefined) return;
      if (target.state === "failed") {
        const retryServer = mcp.retryServer;
        if (retryServer === undefined) return;
        runMcpSurfaceAction(shell, deps, retryServer(target.name), "Retry failed");
        return;
      }
      const url = target.authURL;
      if (target.state !== "needs-auth" || url === undefined) return;
      mcp.openAuthURL(url);
      // The copy is the fallback that makes this work over SSH, where the
      // browser that must receive the redirect is not on this machine.
      void shell.clipboard.writeText(url);
      closeInsetOverlay(shell);
      setStatusFlash(shell, `opening ${target.name} authorization — link copied`, {
        ttlMs: MCP_AUTH_FLASH_MS,
      });
    },
    onAction: (_id, key) => {
      if (key.ctrl || !(key.meta || key.option)) return false;
      const name = typeof key.name === "string" ? key.name.toLowerCase() : "";
      if (name !== "a") return false;
      if (!canAdd) return false;
      unsubscribe();
      openAddMcpNamePane(shell, deps, mcp);
      return true;
    },
  });
  unsubscribe =
    mcp.subscribe?.(() => {
      const liveEntries = mcp.list();
      const liveRows = mcpSurfaceRows(liveEntries, canAdd);
      rows.splice(0, rows.length, ...liveRows);
      byName.clear();
      for (const entry of liveEntries) byName.set(entry.name, entry);
      if (
        !setOwnedOverlayItems(
          shell,
          "mcp",
          rows.map((row) => row.label),
          rows.map((row) => row.id),
        )
      ) {
        unsubscribe();
      }
    }) ?? unsubscribe;
}

/** Long enough to notice the browser was asked to open, and why. */
const MCP_AUTH_FLASH_MS = 6000;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Open the surface a command asked for.
 * Returns false when no surface exists for the kind, so the caller can report
 * the gap rather than silently swallowing the command.
 */
export function openCommandSurface(
  shell: AppShell,
  kind: CommandSurfaceKind,
  deps: CommandSurfaceDeps,
): boolean {
  switch (kind) {
    case "help":
      openHelpOverlay(shell);
      return true;
    case "settings":
      openSettingsSurface(shell, deps);
      return true;
    case "permissions":
      openPermissionsSurface(shell, deps);
      return true;
    case "plugins":
      openPluginsSurface(shell, deps);
      return true;
    case "hooks":
      openHooksSurface(shell, deps);
      return true;
    case "mcp":
      openMcpSurface(shell, deps);
      return true;
    case "models":
      if (deps.openModels === undefined) return false;
      deps.openModels();
      return true;
    case "add-provider":
      if (deps.openAddProvider === undefined) return false;
      deps.openAddProvider();
      return true;
  }
}
