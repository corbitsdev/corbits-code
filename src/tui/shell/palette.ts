/**
 * Palette, slash and mention popups: filtering, open/close, key handling.
 */
import { type KeyEvent } from "@opentui/core";
import { listPathSuggestions } from "../components/at-mention/list.js";
import { parseAtState } from "../components/at-mention/parse.js";
import { sentHistoryOnEdit } from "../sent-message-history.js";
import { spliceMentionCompletion } from "../prompt-attachments.js";
import {
  filterPaletteCommands,
  paletteLabels,
  slashArgItems,
  type PaletteCommand,
} from "../command-catalog.js";
import { helpItems } from "../keybindings.js";
import {
  filterMentionSuggestions,
  splitMentionToken,
} from "../mention-filter.js";

import {
  type AppShell,
  clearMentionAccept,
  isSlashPopupOpen,
  type ItemDescription,
  liveMentionAccept,
  mentionAcceptState,
  type MentionAcceptState,
  mentionGenerations,
  mentionPopups,
  type MentionSuggestionSource,
  type OverlaySelection,
  shellInternals,
  shellMentionSource,
  slashArgQuery,
  slashPopupQuery,
  slashPopups,
} from "./internals.js";
import { relayoutOverlayHost } from "./overlay-list.js";
import {
  closeInsetOverlay,
  closeReplaceableOverlay,
  dispatchPaletteSelection,
  openListOverlay,
  repaintListFilter,
  reserveOverlayHost,
  setOverlayItems,
} from "./overlay-host.js";
import { paintOverlayList } from "./chrome.js";

/** Resolve the shell's registry-backed command catalog (host-injected). */
export function resolvePaletteCatalog(
  shell: AppShell,
): readonly PaletteCommand[] {
  const bag = shellInternals(shell);
  const raw = bag?.paletteCatalog;
  if (raw === null || raw === undefined) return [];
  return typeof raw === "function" ? raw() : raw;
}

/**
 * Replace the shell's `/` command catalog (host rebinds after registry load).
 * Pass null to clear it.
 */
export function setPaletteCatalog(
  shell: AppShell,
  catalog: readonly PaletteCommand[] | (() => readonly PaletteCommand[]) | null,
): void {
  const bag = shellInternals(shell);
  if (bag) bag.paletteCatalog = catalog;
}

/**
 * Open the `/` command list overlay. Catalog: `opts.catalog` when given,
 * else the registry-backed default (see `resolvePaletteCatalog`).
 */
export function openPalette(
  shell: AppShell,
  opts?: {
    readonly query?: string;
    readonly catalog?: readonly PaletteCommand[];
    readonly title?: string;
    /** Claim printable keys for the `>` filter row. Off for the `/` popup. */
    readonly typeToFilter?: boolean;
  },
): void {
  const title = opts?.title ?? "command palette";
  const bag = shellInternals(shell);
  if (bag) {
    bag.paletteFilter = {
      query: opts?.query ?? "",
      title,
      // `/` passes a pre-narrowed catalog; omitting it re-resolves so a
      // later registry load is picked up.
      catalog: opts?.catalog ?? null,
      // The `/` popup keeps its query in the prompt and drives its own reopen.
      typeToFilter: opts?.typeToFilter ?? false,
    };
  }
  repaintPalette(shell);
}

/** Re-open the palette against the current filter state (every keystroke). */
function repaintPalette(shell: AppShell): void {
  const state = shellInternals(shell)?.paletteFilter;
  if (!state) return;
  const catalog = state.catalog ?? resolvePaletteCatalog(shell);
  const commands = filterPaletteCommands(state.query, catalog);
  const labels =
    commands.length > 0 ? paletteLabels(commands) : ["(no matches)"];
  shell.paletteCommands = commands;
  openListOverlay(shell, {
    kind: "palette",
    title: state.title,
    items: labels,
    itemIds: commands.map((c) => c.id),
    describe: (id) => {
      const cmd = commands.find((c) => c.id === id);
      const what = cmd?.description?.trim();
      return what ? { what } : null;
    },
    // Filter row only when the overlay owns keystrokes; `/` keeps its query
    // in the prompt, so `>` would be orphan chrome.
    ...(state.typeToFilter ? { body: `> ${state.query}` } : {}),
    frameId: "command-palette",
  });
  // No title rule row: the box is only ever the palette, and a filter row
  // already shows what's typed.
  shell.overlayTitle.visible = false;
  shell.overlayTitle.content = "";
  paintOverlayList(shell);
}

/**
 * Keys a type-to-filter overlay claims while open, so printable keys feed
 * the `>` filter row. Opt-in (`typeToFilter`): the palette, model picker,
 * and resume picker trade j/k navigation for it; other overlays keep j/k.
 * Arrow and page keys are never claimed.
 */
export function handlePaletteFilterKey(
  shell: AppShell,
  key: KeyEvent,
): boolean {
  const state = shellInternals(shell)?.paletteFilter;
  if (!state?.typeToFilter) return false;
  if (shell.overlayKind !== "palette" || shell.overlayList === null)
    return false;
  if (key.ctrl || key.meta || key.option) return false;

  if (key.name === "backspace") {
    if (state.query.length === 0) return true;
    state.query = state.query.slice(0, -1);
    repaintPalette(shell);
    return true;
  }

  const seq = typeof key.sequence === "string" ? key.sequence : "";
  if (seq.length !== 1 || seq < " ") return false;

  state.query += seq;
  repaintPalette(shell);
  return true;
}

/**
 * Glyphs some terminals emit for Option+A without setting meta/option.
 */
const OPTION_A_COMPOSED_CHARS = new Set(["å", "Å"]);
const OPTION_D_COMPOSED_CHARS = new Set(["∂"]);
const OPTION_R_COMPOSED_CHARS = new Set(["®"]);

/**
 * True when a key event is the model-picker Alt+A add-provider chord.
 * Terminals may deliver Option+A as å/Å without meta/option.
 */
export function isAddProviderShortcutKey(key: KeyEvent): boolean {
  if (key.ctrl) return false;
  const name = typeof key.name === "string" ? key.name : "";
  const seq = typeof key.sequence === "string" ? key.sequence : "";
  if ((key.meta || key.option) && name.toLowerCase() === "a") return true;
  if (OPTION_A_COMPOSED_CHARS.has(name) || OPTION_A_COMPOSED_CHARS.has(seq))
    return true;
  return false;
}

/**
 * True when a key event is the model-picker Alt+D set-default chord.
 * Terminals may deliver Option+D as ∂ without meta/option.
 */
export function isSetDefaultShortcutKey(key: KeyEvent): boolean {
  if (key.ctrl) return false;
  const name = typeof key.name === "string" ? key.name : "";
  const seq = typeof key.sequence === "string" ? key.sequence : "";
  if ((key.meta || key.option) && name.toLowerCase() === "d") return true;
  if (OPTION_D_COMPOSED_CHARS.has(name) || OPTION_D_COMPOSED_CHARS.has(seq))
    return true;
  return false;
}

/**
 * True when a key event is the model-picker Alt+R remove-provider chord.
 * Terminals may deliver Option+R as ® without meta/option. Bare `r` stays
 * false: type-to-filter owns printables.
 */
export function isRemoveProviderShortcutKey(key: KeyEvent): boolean {
  if (key.ctrl) return false;
  const name = typeof key.name === "string" ? key.name : "";
  const seq = typeof key.sequence === "string" ? key.sequence : "";
  if ((key.meta || key.option) && name.toLowerCase() === "r") return true;
  if (OPTION_R_COMPOSED_CHARS.has(name) || OPTION_R_COMPOSED_CHARS.has(seq))
    return true;
  return false;
}

/**
 * Keys a type-to-filter list overlay claims while open. Mirrors the palette
 * filter but updates the open list in place: a busy openListOverlay is a
 * silent no-op unless `deferIfBusy` is set.
 */
export function handleListFilterKey(shell: AppShell, key: KeyEvent): boolean {
  const bag = shellInternals(shell);
  const state = bag?.listFilter;
  if (!state || shell.overlayList === null) return false;
  if (shell.overlayKind === "palette") return false;
  if (key.ctrl || key.meta || key.option) return false;

  // Armed provider hints send the composed Option chords (å/Å, ∂, ®) to
  // runOverlayAction, not type-to-filter.
  if (
    bag?.primaryBindings.addProviderHint === true &&
    shell.overlayKind === "model_picker" &&
    isAddProviderShortcutKey(key)
  ) {
    return false;
  }

  if (
    bag?.primaryBindings.setDefaultHint === true &&
    shell.overlayKind === "model_picker" &&
    isSetDefaultShortcutKey(key)
  ) {
    return false;
  }

  if (
    bag?.primaryBindings.removeProviderHint === true &&
    shell.overlayKind === "model_picker" &&
    isRemoveProviderShortcutKey(key)
  ) {
    return false;
  }

  if (key.name === "backspace") {
    if (state.query.length === 0) return true;
    state.query = state.query.slice(0, -1);
    repaintListFilter(shell);
    return true;
  }

  const seq = typeof key.sequence === "string" ? key.sequence : "";
  if (seq.length !== 1 || seq < " ") return false;

  state.query += seq;
  repaintListFilter(shell);
  return true;
}

/**
 * Host-injected residual list open. `items` is owned by the caller: there is
 * no fallback, so a missing dependency must surface an honest empty state or
 * error upstream. Per-open `onAccept` wins over shell-level residual hooks.
 */
export interface OpenResidualListOpts {
  readonly items: readonly string[];
  /** Stable ids aligned with `items` (setting keys, session ids, paths). */
  readonly itemIds?: readonly string[];
  /** Plain chosen value aligned with `items`, for the accept echo (see
   * `OpenListOverlayOpts.itemValues`). */
  readonly itemValues?: readonly (string | undefined)[];
  readonly activeIndex?: number;
  /** Per-open accept; host binds toggle / resume / mention insert. */
  readonly onAccept?: (selection: OverlaySelection) => void;
  /** Per-open ← → cycle hook (settings inline value cycling). */
  readonly onCycle?: (itemId: string, direction: -1 | 1) => void;
  /** Per-open description-zone source. */
  readonly describe?: (itemId: string) => ItemDescription | null;
}

export function openSettingsOverlay(
  shell: AppShell,
  opts: OpenResidualListOpts,
): void {
  openListOverlay(shell, {
    kind: "settings",
    title: "settings",
    items: opts.items,
    activeIndex: opts.activeIndex ?? 0,
    frameId: "overlay-settings",
    deferIfBusy: true,
    ...(opts.itemIds !== undefined ? { itemIds: opts.itemIds } : {}),
    ...(opts.itemValues !== undefined ? { itemValues: opts.itemValues } : {}),
    ...(opts.onAccept !== undefined ? { onAccept: opts.onAccept } : {}),
    ...(opts.onCycle !== undefined ? { onCycle: opts.onCycle } : {}),
    ...(opts.describe !== undefined ? { describe: opts.describe } : {}),
  });
}

export function openHelpOverlay(shell: AppShell): void {
  const release = reserveOverlayHost(shell);
  try {
    closeReplaceableOverlay(shell);
    openListOverlay(shell, {
      kind: "help",
      title: "help · keymap",
      items: helpItems(),
      activeIndex: 0,
      frameId: "overlay-help",
      deferIfBusy: true,
    });
  } finally {
    release();
  }
}

export function openMentionsOverlay(
  shell: AppShell,
  opts: OpenResidualListOpts,
): void {
  openListOverlay(shell, {
    kind: "mentions",
    title: "mentions",
    items: opts.items,
    activeIndex: opts.activeIndex ?? 0,
    frameId: "overlay-mentions",
    ...(opts.itemIds !== undefined ? { itemIds: opts.itemIds } : {}),
    ...(opts.onAccept !== undefined ? { onAccept: opts.onAccept } : {}),
  });
}

/** Keys that only move the caret — they must not cancel history browsing. */
export const MOTION_KEYS: ReadonlySet<string> = new Set([
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
  "tab",
  "escape",
]);

const defaultMentionSource: MentionSuggestionSource = (prefix) =>
  listPathSuggestions(prefix, process.cwd());

/**
 * Open path suggestions for the @token under the cursor and splice the
 * accepted entry back into the prompt. Directory picks re-open one level
 * down so the operator can drill in without typing the path.
 *
 * Returns false when the cursor is not on an @token, nothing matched, a
 * newer lookup superseded this one, or the overlay host was taken.
 */
export async function openAtMentionSuggestions(
  shell: AppShell,
): Promise<boolean> {
  const at = parseAtState(shell.prompt.value, shell.prompt.cursorOffset);
  if (at === null) {
    closeMentionPopup(shell);
    return false;
  }

  // Every keystroke re-queries; a slower earlier query must not overwrite a
  // later list.
  const generation = (mentionGenerations.get(shell) ?? 0) + 1;
  mentionGenerations.set(shell, generation);

  const source = shellMentionSource.get(shell) ?? defaultMentionSource;
  const token = splitMentionToken(at.prefix);
  let suggestions = filterMentionSuggestions(
    await source(token.dir),
    token.fragment,
  );
  // Quitting mid-lookup tears down the renderer this function writes into;
  // a resolved-but-stale lookup must not touch it.
  if (shell.disposed) return false;
  // The source caps entries per directory, so a big directory can cap out
  // before an interior match appears; its own prefix filter puts the cap
  // after the narrowing.
  if (suggestions.length === 0 && token.fragment.length > 0) {
    suggestions = await source(at.prefix);
    if (shell.disposed) return false;
  }
  if (mentionGenerations.get(shell) !== generation) return false;

  if (suggestions.length === 0) {
    // Mirrors `/`'s no-match contract: close the popup and leave the typed
    // text standing, with no empty-state message.
    closeMentionPopup(shell);
    return false;
  }

  // The operator may have left this token mid-lookup; do not open or arm
  // accept unless the cursor is still on this @ (same atStart).
  const liveAt = parseAtState(shell.prompt.value, shell.prompt.cursorOffset);
  if (liveAt === null || liveAt.atStart !== at.atStart) {
    closeMentionPopup(shell);
    return false;
  }

  // onAccept reads mentionAcceptState, not a `suggestions` closure, so a
  // same-session refresh updates the splice without re-binding. atStart
  // pins the starting @; the splice end is the live cursor.
  const acceptState: MentionAcceptState = {
    suggestions,
    generation,
    atStart: at.atStart,
  };

  // Already open: refresh in place. Reopening would release the host long
  // enough for a queued permission/operator gate to drain onto it;
  // refreshing never releases it.
  if (isMentionPopupOpen(shell)) {
    mentionAcceptState.set(shell, acceptState);
    setOverlayItems(shell, [...suggestions]);
    return true;
  }

  closeMentionPopup(shell);
  openMentionsOverlay(shell, {
    items: [...suggestions],
    onAccept: (selection) => {
      const ready = liveMentionAccept(shell);
      if (ready === null) return;
      const completion = ready.state.suggestions[selection.index];
      if (completion === undefined) return;
      const spliced = spliceMentionCompletion(
        shell.prompt.value,
        ready.live.atStart,
        shell.prompt.cursorOffset,
        completion,
      );
      editPromptAt(shell, spliced.value, spliced.cursor);
      if (completion.endsWith("/")) void openAtMentionSuggestions(shell);
    },
  });
  if (shell.overlayKind !== "mentions") return false;
  mentionAcceptState.set(shell, acceptState);
  mentionPopups.add(shell);
  return true;
}

/** True while the `@` path popup owns typed characters. */
export function isMentionPopupOpen(shell: AppShell): boolean {
  return mentionPopups.has(shell) && shell.overlayKind === "mentions";
}

export function closeMentionPopup(shell: AppShell): void {
  if (!mentionPopups.has(shell)) return;
  clearMentionAccept(shell);
  mentionPopups.delete(shell);
  if (shell.overlayList) closeInsetOverlay(shell);
}

function editPromptAt(shell: AppShell, value: string, cursor: number): void {
  shell.prompt.value = value;
  shell.prompt.cursorOffset = cursor;
  shell.sentHistory = sentHistoryOnEdit(shell.sentHistory);
}

/**
 * Keys the `@` popup claims while open — the `/` popup contract: printables
 * narrow the list, Backspace widens it, and no match closes the popup with
 * the typed text left in place. The prompt does not hold focus while the
 * overlay is open, so this edits the text itself instead of the
 * InputRenderable.
 */
export function handleMentionPopupKey(shell: AppShell, key: KeyEvent): boolean {
  if (!isMentionPopupOpen(shell) || shell.overlayList === null) return false;
  if (key.ctrl || key.meta || key.option) return false;

  const value = shell.prompt.value;
  const cursor = shell.prompt.cursorOffset;

  if (key.name === "backspace") {
    if (cursor === 0) {
      closeMentionPopup(shell);
      return true;
    }
    editPromptAt(
      shell,
      value.slice(0, cursor - 1) + value.slice(cursor),
      cursor - 1,
    );
    // Deleting `@` itself ends the mention; nothing is left to filter.
    if (value[cursor - 1] === "@") closeMentionPopup(shell);
    else void openAtMentionSuggestions(shell);
    return true;
  }

  const seq = typeof key.sequence === "string" ? key.sequence : "";
  if (seq.length !== 1 || seq < " ") return false;

  editPromptAt(
    shell,
    value.slice(0, cursor) + seq + value.slice(cursor),
    cursor + 1,
  );
  // Whitespace terminates the @token, so the popup has nothing left to narrow.
  if (/\s/.test(seq)) closeMentionPopup(shell);
  else void openAtMentionSuggestions(shell);
  return true;
}

export function closeSlashPopup(
  shell: AppShell,
  opts?: { readonly suppressIdleNotify?: boolean },
): void {
  if (!slashPopups.has(shell)) return;
  slashPopups.delete(shell);
  if (shell.overlayList) closeInsetOverlay(shell, opts);
}

/**
 * Open (or refresh) the `/` popup for the name being typed. Reuses the
 * palette overlay so accept dispatches like a typed `/name`. Returns false
 * when nothing matches — the typed text stays.
 */
export function openSlashCommands(shell: AppShell): boolean {
  const query = slashPopupQuery(shell);
  if (query !== null) {
    // Name-prefix, not the palette's fuzzy label match: at the prompt the
    // operator is typing the command they already mean.
    const q = query.toLowerCase();
    const matches = resolvePaletteCatalog(shell).filter((cmd) =>
      cmd.id.toLowerCase().startsWith(q),
    );

    // Already open: refresh in place. Reopening would release the host
    // (closeSlashPopup idle-notifies) long enough for a queued
    // permission/operator gate to drain onto it; refreshing never releases
    // it. A typo that zeroes the matches must not close either — hold a
    // "(no matches)" row until a dismiss or a backspace restores matches.
    if (isSlashPopupOpen(shell) && shell.overlayKind === "palette") {
      refreshSlashPopupInPlace(shell, matches);
      return true;
    }

    if (matches.length === 0) {
      closeSlashPopup(shell);
      return false;
    }

    closeSlashPopup(shell);
    openPalette(shell, { catalog: matches, title: "commands · /" });
    slashPopups.add(shell);
    return true;
  }
  return openSlashArgRows(shell);
}

/**
 * Second stage: `/name` is settled; the tail filters the arg rows —
 * subcommands by name prefix, or the free-form hint as one reminder row
 * while the tail is empty. Unknown names and arg-less commands dismiss
 * silently: this runs on mid-word keystroke re-parses, and the default
 * idle-notify would drain a queued permission/operator gate onto the host.
 */
function openSlashArgRows(shell: AppShell): boolean {
  const argQuery = slashArgQuery(shell);
  if (argQuery === null) {
    closeSlashPopup(shell);
    return false;
  }
  // Two or more tokens past the name (`/deploy prod --force`): filtering is
  // over — subcommand rows match one prefix token and a hint row only shows
  // on an empty tail — so dismiss rather than hold a dead "(no matches)"
  // while real arguments are typed. A trailing space after one token
  // (`/deploy prod `) still filters.
  if (/\s/.test(argQuery.arg.trim())) {
    closeSlashPopup(shell, { suppressIdleNotify: true });
    return false;
  }
  const cmd = resolvePaletteCatalog(shell).find(
    (c) => c.id.toLowerCase() === argQuery.name.toLowerCase(),
  );
  const rows = cmd !== undefined ? slashArgItems(cmd, argQuery.arg) : [];
  if (rows.length === 0) {
    // An empty arg stage usually means "nothing to offer" (arg-less command,
    // hint typed over), not a recoverable typo — dismiss rather than hold a
    // dead "(no matches)" while free-form args are typed. Subcommand
    // filtering is the exception: a zeroed single-token prefix recovers by
    // typing, so hold the host like the name stage does.
    const filterable = (cmd?.subcommands?.length ?? 0) > 0;
    if (
      filterable &&
      isSlashPopupOpen(shell) &&
      shell.overlayKind === "palette"
    ) {
      refreshSlashPopupInPlace(shell, rows);
      return true;
    }
    closeSlashPopup(shell, { suppressIdleNotify: true });
    return false;
  }
  if (isSlashPopupOpen(shell) && shell.overlayKind === "palette") {
    refreshSlashPopupInPlace(shell, rows);
    return true;
  }
  closeSlashPopup(shell);
  openPalette(shell, { catalog: rows, title: "commands · /" });
  slashPopups.add(shell);
  return true;
}

/** Refresh the already-open `/` popup's rows in place for the given matches. */
function refreshSlashPopupInPlace(
  shell: AppShell,
  matches: readonly PaletteCommand[],
): void {
  const labels = matches.length > 0 ? paletteLabels(matches) : ["(no matches)"];
  shell.paletteCommands = matches;
  const bag = shellInternals(shell);
  if (bag) {
    bag.paletteFilter = {
      query: bag.paletteFilter?.query ?? "",
      title: "commands · /",
      catalog: matches,
      typeToFilter: false,
    };
    bag.primaryBindings.describe = (id) => {
      const cmd = matches.find((c) => c.id === id);
      const what = cmd?.description?.trim();
      return what ? { what } : null;
    };
  }
  setOverlayItems(
    shell,
    labels,
    matches.map((c) => c.id),
    undefined,
    {
      resetActive: true,
    },
  );
  relayoutOverlayHost(shell, labels.length);
}

export function setPromptText(shell: AppShell, value: string): void {
  shell.prompt.value = value;
  shell.prompt.cursorOffset = value.length;
  shell.sentHistory = sentHistoryOnEdit(shell.sentHistory);
}

/**
 * setPromptText plus a selected span. The hint lands as real selected text,
 * not ghost paint: the textarea owns selection, so typing replaces the span
 * with no extra bookkeeping, and a ghost-paint renderer has no precedent.
 */
function setPromptTextWithSelection(
  shell: AppShell,
  value: string,
  start: number,
  end: number,
): void {
  setPromptText(shell, value);
  shell.prompt.setSelection(start, end);
}

/**
 * Complete a second-stage arg row into the prompt. Arg rows are fragments,
 * never dispatch: a subcommand completes to `/parent sub ` with the caret
 * past the space; a free-form hint completes to selected text so typing
 * replaces it.
 */
function completeSlashArgRow(shell: AppShell, row: PaletteCommand): void {
  const base = `/${row.parentId ?? row.id} `;
  if (row.argKind === "hint" && row.argValue !== undefined) {
    setPromptTextWithSelection(
      shell,
      `${base}${row.argValue}`,
      base.length,
      base.length + row.argValue.length,
    );
    return;
  }
  setPromptText(shell, `${base}${row.argValue ?? ""} `);
}

/**
 * Keys the `/` popup claims while open. Returns true when handled.
 *
 * Enter runs the highlighted command with no arguments (bare dispatch even
 * for param commands — the typed `/name` already says what to run, and an
 * untouched Tab-accepted hint is stripped at submit). Tab completes the
 * name instead; commands with an argumentHint or subcommands open the
 * second-stage arg rows, param-less commands keep the bare `/id ` accept
 * and close.
 */
export function handleSlashPopupKey(shell: AppShell, key: KeyEvent): boolean {
  if (!isSlashPopupOpen(shell) || shell.overlayList === null) return false;

  if (key.name === "backspace" && !key.ctrl && !key.meta && !key.option) {
    // A Tab-accepted hint sits selected; backspace clears the span so the
    // re-parse below lands on the arg rows, not truncated text with a stale
    // selection.
    if (shell.prompt.hasSelection()) {
      shell.prompt.deleteSelection();
      shell.sentHistory = sentHistoryOnEdit(shell.sentHistory);
    } else {
      setPromptText(shell, shell.prompt.value.slice(0, -1));
    }
    openSlashCommands(shell);
    return true;
  }

  const active = shell.paletteCommands[shell.overlayList.activeIndex];
  const activeArgRow =
    active !== undefined &&
    active.parentId !== undefined &&
    active.argValue !== undefined
      ? active
      : undefined;

  if (
    key.name === "tab" &&
    !key.shift &&
    !key.ctrl &&
    !key.meta &&
    !key.option
  ) {
    if (activeArgRow !== undefined) {
      completeSlashArgRow(shell, activeArgRow);
      closeSlashPopup(shell);
      return true;
    }
    if (active === undefined) {
      closeSlashPopup(shell);
      return true;
    }
    if (
      active.argumentHint !== undefined ||
      (active.subcommands !== undefined && active.subcommands.length > 0)
    ) {
      // Param command: complete the name and open the second stage so the
      // hint/subcommand rows stay visible while args are typed.
      setPromptText(shell, `/${active.id} `);
      openSlashCommands(shell);
      return true;
    }
    setPromptText(shell, `/${active.id} `);
    closeSlashPopup(shell);
    return true;
  }

  if (
    (key.name === "return" || key.name === "enter") &&
    !key.ctrl &&
    !key.meta &&
    !key.option
  ) {
    // Zero-match dismiss still notifies immediately so a queued gate can
    // drain; accept-with-match keeps the host until dispatch settles.
    if (activeArgRow !== undefined) {
      completeSlashArgRow(shell, activeArgRow);
      closeSlashPopup(shell);
      return true;
    }
    if (!active) {
      closeSlashPopup(shell);
      return true;
    }
    setPromptText(shell, "");
    slashPopups.delete(shell);
    const release = reserveOverlayHost(shell);
    closeInsetOverlay(shell);
    try {
      dispatchPaletteSelection(shell, active);
    } finally {
      release();
    }
    return true;
  }

  const seq = typeof key.sequence === "string" ? key.sequence : "";
  const printable =
    seq.length === 1 &&
    seq >= " " &&
    seq !== "" &&
    !key.ctrl &&
    !key.meta &&
    !key.option;
  if (!printable) return false;

  // A selected span (manual, or a just-completed hint row whose popup stayed
  // open) is replaced by the typed character; otherwise append.
  if (shell.prompt.hasSelection()) {
    shell.prompt.deleteSelection();
    shell.prompt.insertText(seq);
    shell.sentHistory = sentHistoryOnEdit(shell.sentHistory);
  } else {
    setPromptText(shell, shell.prompt.value + seq);
  }
  if (/\s/.test(seq)) {
    // Whitespace settles the name; re-parse into the second stage so the
    // rows offer themselves while args are typed.
    openSlashCommands(shell);
    return true;
  }
  openSlashCommands(shell);
  return true;
}
