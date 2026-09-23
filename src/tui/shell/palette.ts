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
 * Open the `/` command list overlay. Catalog: opts.catalog when given, else
 * the shell's registry-backed default (see `resolvePaletteCatalog`).
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
      // `/` passes a pre-narrowed catalog; omitting it re-resolves the shell
      // default so a registry loaded later is picked up.
      catalog: opts?.catalog ?? null,
      // The `/` popup keeps its query in the prompt and drives its own reopen.
      typeToFilter: opts?.typeToFilter ?? false,
    };
  }
  repaintPalette(shell);
}

/** Re-open the palette against the current filter state (used on every keystroke). */
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
    // Typed filter row only when the overlay owns keystrokes. The `/` popup
    // keeps its query in the prompt, so a body of `>` would be orphan chrome.
    ...(state.typeToFilter ? { body: `> ${state.query}` } : {}),
    frameId: "command-palette",
  });
  // No title rule row: the box is only ever the palette, and when a filter
  // row is present it already shows what's typed.
  shell.overlayTitle.visible = false;
  shell.overlayTitle.content = "";
  paintOverlayList(shell);
}

/**
 * Keys a type-to-filter list claims while it is open, so the `>` row filters
 * as you type.
 *
 * Opt-in per open (`typeToFilter`): palette, the flat model picker, and the
 * resume picker give up j/k navigation so printable keys feed the filter.
 * Overlays without type-to-filter (permissions, workers, copy, …) keep j/k. Arrow and
 * page keys are never claimed here, so they keep working in every overlay
 * including type-to-filter ones.
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
 * Keys a type-to-filter list overlay claims while open, so the `>` row
 * narrows as you type. Mirrors the palette filter, but updates the open
 * list in place via setOverlayItems (a busy openListOverlay is a silent
 * no-op unless `deferIfBusy` is set).
 */
export function handleListFilterKey(shell: AppShell, key: KeyEvent): boolean {
  const bag = shellInternals(shell);
  const state = bag?.listFilter;
  if (!state || shell.overlayList === null) return false;
  if (shell.overlayKind === "palette") return false;
  if (key.ctrl || key.meta || key.option) return false;

  // addProviderHint also gates this filter-bypass so composed Option+A
  // (å/Å) reaches runOverlayAction instead of type-to-filter.
  if (
    bag?.primaryBindings.addProviderHint === true &&
    shell.overlayKind === "model_picker" &&
    isAddProviderShortcutKey(key)
  ) {
    return false;
  }

  // setDefaultHint similarly gates the composed Option+D (∂) bypass. Outside
  // this model-picker action context, ∂ remains ordinary filter text.
  if (
    bag?.primaryBindings.setDefaultHint === true &&
    shell.overlayKind === "model_picker" &&
    isSetDefaultShortcutKey(key)
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
 * Host-injected residual list open. `items` is owned by the caller — there is
 * no fallback, so a missing dependency must produce an honest empty state or
 * a surfaced error upstream rather than reach this with nothing to show.
 * Per-open `onAccept` wins over shell-level residual hooks for that open.
 */
export interface OpenResidualListOpts {
  readonly items: readonly string[];
  /** Stable ids aligned with `items` (setting keys, session ids, paths). */
  readonly itemIds?: readonly string[];
  /** Plain chosen value aligned with `items`, for the accept echo (see `OpenListOverlayOpts.itemValues`). */
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
 * Returns false when the cursor is not inside an @token, nothing matched,
 * a newer lookup superseded this one, or the overlay host was taken.
 *
 * Accept requires a current generation and a live `@` token under the cursor.
 * A lookup that finishes after the cursor has left this token does not open.
 */
export async function openAtMentionSuggestions(
  shell: AppShell,
): Promise<boolean> {
  const at = parseAtState(shell.prompt.value, shell.prompt.cursorOffset);
  if (at === null) {
    closeMentionPopup(shell);
    return false;
  }

  // Every keystroke re-queries; a slower earlier query must not overwrite the
  // list a later one already produced.
  const generation = (mentionGenerations.get(shell) ?? 0) + 1;
  mentionGenerations.set(shell, generation);

  const source = shellMentionSource.get(shell) ?? defaultMentionSource;
  const token = splitMentionToken(at.prefix);
  let suggestions = filterMentionSuggestions(
    await source(token.dir),
    token.fragment,
  );
  // Quitting mid-lookup tears down the renderer/TextBuffer this function
  // writes into below; a resolved-but-stale lookup must not touch them.
  if (shell.disposed) return false;
  // The source caps how many entries it returns per directory, so a large
  // directory can cap out before the interior match appears. Asking it to do
  // its own prefix filter puts that cap after the narrowing instead of before.
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

  // The operator may have left this token while the lookup was in flight.
  // Do not open, and do not arm accept, unless the cursor is still on this @
  // (same atStart). A different live @token is not this lookup.
  const liveAt = parseAtState(shell.prompt.value, shell.prompt.cursorOffset);
  if (liveAt === null || liveAt.atStart !== at.atStart) {
    closeMentionPopup(shell);
    return false;
  }

  // The onAccept closure reads mentionAcceptState rather than closing over
  // `suggestions` directly, so a same-session refresh can update what accept
  // splices without re-binding the callback. atStart is the @ this lookup
  // started on; the splice end is the live cursor.
  const acceptState: MentionAcceptState = {
    suggestions,
    generation,
    atStart: at.atStart,
  };

  // Every keystroke lands here while the popup is already open. Closing and
  // reopening the overlay released the host between the two calls — long
  // enough for a queued permission/operator gate to open on it — and left the
  // gate's overlay on screen while `mentionPopups` still claimed ownership.
  // Refreshing the open list in place never releases the host, so a queued
  // gate has nothing to drain into.
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
 * Keys the `@` popup claims while open — the same contract as the `/` popup:
 * printable characters narrow the list, Backspace widens it, and a query that
 * matches nothing closes the popup with the typed text left in place.
 *
 * The prompt does not hold focus while the overlay is open, so this inserts and
 * deletes the characters itself rather than letting the InputRenderable do it.
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
    // Deleting the `@` itself ends the mention; there is nothing left to filter.
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
 * Open (or refresh) the `/` command popup for the name being typed. Reuses the
 * palette overlay so accept dispatches through the same registry path as a
 * typed `/name`. Returns false when nothing matches — the typed text stays.
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

    // Every keystroke lands here while the popup is already open. Closing and
    // reopening released the overlay host between the two calls (closeSlashPopup
    // routes through closeInsetOverlay, which idle-notifies) — long enough for a
    // queued permission/operator gate to drain onto it. Refreshing the open
    // palette in place never releases the host, so a queued gate has nothing to
    // drain into. priorOverlay stacking is untouched here (it is only ever
    // written by openListOverlay's stack-on-open path), so a palette stacked
    // over a prior overlay keeps that snapshot across the refresh.
    //
    // A typo that zeroes the matches must not fall through to closeSlashPopup
    // while the popup is already open — that closes through the same idle-notify
    // path and drains a queued gate mid-filter. Instead this refreshes in place
    // to a "(no matches)" row, same as the general palette does, and holds the
    // host until a real dismiss (deleting the `/`, Esc, accept) or a backspace
    // that restores matches.
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
 * Second stage: `/name` is settled (whitespace follows) and the tail filters
 * the command's arg rows — subcommand choices by name prefix, or the
 * free-form hint as a single reminder row while the tail is still empty.
 * Unknown names and arg-less commands (`/mcp `) dismiss the popup, keeping
 * today's dismiss for commands that take no params — but silently: this runs
 * on keystroke re-parses while the operator is mid-word, and the default
 * idle-notify would drain a queued permission/operator gate onto the host.
 */
function openSlashArgRows(shell: AppShell): boolean {
  const argQuery = slashArgQuery(shell);
  if (argQuery === null) {
    closeSlashPopup(shell);
    return false;
  }
  // Two or more tokens past the name (`/deploy prod --force`): the popup's
  // filtering job is over — subcommand rows only ever match a single prefix
  // token and a hint row only shows on the empty tail — so dismiss instead of
  // holding a dead "(no matches)" while real arguments are typed. A trailing
  // space after one token (`/deploy prod `) still filters; only genuinely
  // multi-token tails dismiss.
  if (/\s/.test(argQuery.arg.trim())) {
    closeSlashPopup(shell, { suppressIdleNotify: true });
    return false;
  }
  const cmd = resolvePaletteCatalog(shell).find(
    (c) => c.id.toLowerCase() === argQuery.name.toLowerCase(),
  );
  const rows = cmd !== undefined ? slashArgItems(cmd, argQuery.arg) : [];
  if (rows.length === 0) {
    // Unlike the name stage, an empty arg stage usually means "nothing to
    // offer" (arg-less command, hint already being typed over) rather than a
    // recoverable typo, so dismiss instead of holding a dead "(no matches)"
    // while free-form args are typed. Subcommand filtering is the exception:
    // a zeroed single-token prefix is still recoverable by typing, so hold
    // the host exactly like the name stage does.
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
 * setPromptText plus a selected span. Choice A from the popup-params notes:
 * the hint lands as real selected text (not ghost paint) because the
 * textarea already owns selection — setSelection/insertText/deleteSelection
 * all exist on the widget (see the yank-rotation path in keys.ts) — and the
 * next keystroke's insert replaces the span, so typing over the hint works
 * with no extra bookkeeping. Ghost paint-only would need a custom prompt-box
 * renderer with no precedent in the tree.
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
 * not runnable commands, so they never dispatch: a subcommand completes to
 * `/parent sub ` with the caret parked past the space, while a free-form
 * hint completes to selected text (choice A above) so typing replaces it.
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
 * Enter runs the highlighted command with no arguments (bare dispatch, even
 * for param commands — the typed `/name` already says what to run, and an
 * untouched Tab-accepted hint is stripped at submit so it never arrives as a
 * literal argument). Tab instead completes the name so arguments can be
 * typed. Commands carrying an
 * argumentHint or subcommands complete to `/id ` and open the second-stage
 * arg rows; param-less commands keep the bare `/id ` accept and close.
 */
export function handleSlashPopupKey(shell: AppShell, key: KeyEvent): boolean {
  if (!isSlashPopupOpen(shell) || shell.overlayList === null) return false;

  if (key.name === "backspace" && !key.ctrl && !key.meta && !key.option) {
    // A Tab-accepted hint sits selected; backspace clears the span itself so
    // the stage re-parse below lands back on the arg rows, not on truncated
    // text with a stale selection.
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
      // hint/subcommand rows stay visible while args are typed. Param-less
      // commands keep today's bare `/id ` accept below.
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
    // Genuine dismiss (zero matches) still notifies immediately so a queued
    // gate can drain. Accept-with-match keeps the host until dispatch settles.
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

  // A selected span (manual select, or a just-completed hint row whose popup
  // stayed open) is replaced by the typed character; otherwise append as
  // before. The no-selection path is byte-for-byte today's behavior.
  if (shell.prompt.hasSelection()) {
    shell.prompt.deleteSelection();
    shell.prompt.insertText(seq);
    shell.sentHistory = sentHistoryOnEdit(shell.sentHistory);
  } else {
    setPromptText(shell, shell.prompt.value + seq);
  }
  if (/\s/.test(seq)) {
    // Whitespace settles the name; re-parse into the second stage instead of
    // closing so subcommand/hint rows offer themselves while args are typed.
    // openSlashArgRows closes itself for unknown names and arg-less commands.
    openSlashCommands(shell);
    return true;
  }
  openSlashCommands(shell);
  return true;
}
