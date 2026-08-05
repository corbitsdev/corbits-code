/**
 * OpenTUI app shell frame — header, sticky transcript, prompt, status.
 *
 * Functional Corbits wrappers around @opentui/core class renderables
 * (class API required: VNode ScrollBox broke scrollTop in the spike).
 * Not wired to the production CLI entry; Ink remains production.
 */

import {
  BoxRenderable,
  CliRenderEvents,
  InputRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core";

import {
  createFocusState,
  focusOwner,
  focusPrompt,
  focusTranscript,
  type FocusState,
} from "./focus/index.js";
import {
  resolveGeometry,
  type GeometryLayout,
  type ZoneVisibility,
} from "./geometry/index.js";

/** Renderer surface required by the shell (CliRenderer / createTestRenderer). */
export type ShellRenderer = Pick<
  CliRenderer,
  "root" | "width" | "height" | "keyInput" | "on" | "off"
>;

export type AppShellOptions = {
  /** Header label. Default "corbits". */
  readonly title?: string;
  /** Zone visibility overrides for resolveGeometry. model_bar off by default. */
  readonly visibility?: ZoneVisibility;
  /** Requested prompt content rows (geometry caps at 40%). Default 3. */
  readonly promptContentRows?: number;
  /** Pending queue count shown in status. Default 0. */
  readonly pendingQueue?: number;
  /** Wire Tab focus toggle on keyInput. Default true. */
  readonly wireKeys?: boolean;
  /** Mount shell.root on renderer.root. Default true. */
  readonly mount?: boolean;
  /** Initial terminal size override (tests). Defaults to renderer.width/height. */
  readonly terminal?: { readonly columns: number; readonly rows: number };
};

export type AppShell = {
  readonly renderer: ShellRenderer;
  readonly root: BoxRenderable;
  readonly header: TextRenderable;
  readonly headerBox: BoxRenderable;
  readonly transcript: ScrollBoxRenderable;
  readonly prompt: InputRenderable;
  readonly promptBox: BoxRenderable;
  readonly status: TextRenderable;
  readonly statusBox: BoxRenderable;
  /** Latest geometry resolution (updated on resize / relayout). */
  layout: GeometryLayout;
  /** Focus tree + scroll lease (updated by shell helpers). */
  focus: FocusState;
  /** Pending queue count placeholder (status bar). */
  pendingQueue: number;
  /** Transcript line count (append counter). */
  lineCount: number;
  /** Detach key/resize listeners and unmount root. */
  dispose: () => void;
};

const DEFAULT_TITLE = "corbits";

function terminalOf(
  renderer: ShellRenderer,
  override?: { readonly columns: number; readonly rows: number },
): { columns: number; rows: number } {
  if (override) {
    return {
      columns: Math.max(1, Math.floor(override.columns)),
      rows: Math.max(1, Math.floor(override.rows)),
    };
  }
  return {
    columns: Math.max(1, Math.floor(renderer.width || 80)),
    rows: Math.max(1, Math.floor(renderer.height || 24)),
  };
}

function defaultVisibility(visibility?: ZoneVisibility): ZoneVisibility {
  // Minimal shell owns header / transcript / prompt / status.
  // model_bar is constitution always-on idle, but off until chrome task lands.
  return {
    modelBar: false,
    header: 2,
    status: 1,
    ...visibility,
  };
}

/** Whether the transcript viewport is stuck to the bottom (FOLLOW vs PINNED). */
export function isTranscriptFollowing(shell: AppShell): boolean {
  const { transcript } = shell;
  const max = Math.max(0, transcript.scrollHeight - transcript.height);
  return transcript.scrollTop >= max - 1;
}

/** Status mode label from sticky state. */
export function stickyMode(shell: AppShell): "FOLLOW" | "PINNED" {
  return isTranscriptFollowing(shell) ? "FOLLOW" : "PINNED";
}

/** Rebuild status line from focus + sticky + pending queue. */
export function paintStatus(shell: AppShell): void {
  const mode = stickyMode(shell);
  const owner = focusOwner(shell.focus);
  shell.status.content =
    ` ${mode} · queue ${shell.pendingQueue} · focus ${owner} · lines ${shell.lineCount}`;
}

/** Apply focus state to OpenTUI focusables (prompt Input vs transcript ScrollBox). */
export function applyFocus(shell: AppShell): void {
  const owner = focusOwner(shell.focus);
  if (owner === "transcript") {
    shell.transcript.focus();
  } else {
    shell.prompt.focus();
  }
  paintStatus(shell);
}

/** Shell-only: focus the prompt (typing). */
export function shellFocusPrompt(shell: AppShell): void {
  shell.focus = focusPrompt(shell.focus);
  applyFocus(shell);
}

/** Shell-only: focus the transcript (browse / scroll lease). */
export function shellFocusTranscript(shell: AppShell): void {
  shell.focus = focusTranscript(shell.focus);
  applyFocus(shell);
}

/** Tab toggle between prompt and transcript when shell-only. */
export function toggleShellFocus(shell: AppShell): void {
  const owner = focusOwner(shell.focus);
  if (owner === "transcript") {
    shellFocusPrompt(shell);
  } else {
    shellFocusTranscript(shell);
  }
}

/** Apply geometry heights to chrome regions. */
export function applyLayout(shell: AppShell, layout: GeometryLayout): void {
  shell.layout = layout;
  const h = layout.heights;

  const headerH = Math.max(1, h.header);
  shell.headerBox.height = headerH;
  shell.headerBox.visible = headerH > 0;

  const transcriptH = Math.max(0, h.transcript);
  shell.transcript.height = transcriptH > 0 ? transcriptH : 1;
  shell.transcript.visible = transcriptH > 0;

  const promptH = Math.max(1, h.prompt);
  shell.promptBox.height = promptH;
  shell.promptBox.visible = promptH > 0;

  const statusH = Math.max(1, h.status);
  shell.statusBox.height = statusH;
  shell.statusBox.visible = statusH > 0;

  paintStatus(shell);
}

/**
 * Re-resolve geometry from terminal size (resize path).
 * Uses current shell options stored on the shell bag via closures in createAppShell.
 */
export type RelayoutOpts = {
  readonly columns?: number;
  readonly rows?: number;
  readonly visibility?: ZoneVisibility;
  readonly promptContentRows?: number;
};

type ShellInternals = {
  visibility: ZoneVisibility;
  promptContentRows: number | undefined;
};

const internals = new WeakMap<AppShell, ShellInternals>();

export function relayout(shell: AppShell, opts?: RelayoutOpts): GeometryLayout {
  const bag = internals.get(shell);
  const visibility = opts?.visibility ?? bag?.visibility ?? defaultVisibility();
  const promptContentRows = opts?.promptContentRows ?? bag?.promptContentRows;
  if (bag) {
    bag.visibility = visibility;
    bag.promptContentRows = promptContentRows;
  }

  const columns = opts?.columns ?? shell.renderer.width;
  const rows = opts?.rows ?? shell.renderer.height;
  const layout = resolveGeometry({
    terminal: terminalOf(shell.renderer, { columns, rows }),
    visibility,
    ...(promptContentRows !== undefined ? { promptContentRows } : {}),
  });
  applyLayout(shell, layout);
  return layout;
}

/**
 * Append a line to the sticky transcript ScrollBox.
 * stickyScroll + stickyStart "bottom" auto-follow until the operator scrolls up.
 */
export function appendTranscript(
  shell: AppShell,
  line: string,
  opts?: { readonly fg?: string },
): void {
  shell.lineCount += 1;
  const id = String(shell.lineCount).padStart(4, "0");
  shell.transcript.add(
    new TextRenderable(shell.renderer as CliRenderer, {
      content: ` ${id}  ${line}`,
      fg: opts?.fg ?? "#a9b1d6",
    }),
  );
  paintStatus(shell);
}

export function setHeader(shell: AppShell, text: string): void {
  shell.header.content = ` ${text}`;
}

export function setPendingQueue(shell: AppShell, count: number): void {
  shell.pendingQueue = Math.max(0, Math.floor(count));
  paintStatus(shell);
}

/**
 * Build the app shell frame on an OpenTUI renderer.
 * Mounts header / sticky transcript / prompt / status and wires focus + resize.
 */
export function createAppShell(
  renderer: ShellRenderer,
  options?: AppShellOptions,
): AppShell {
  const title = options?.title ?? DEFAULT_TITLE;
  const visibility = defaultVisibility(options?.visibility);
  const promptContentRows = options?.promptContentRows;
  const wireKeys = options?.wireKeys !== false;
  const mount = options?.mount !== false;

  const terminal = terminalOf(renderer, options?.terminal);
  const layout = resolveGeometry({
    terminal,
    visibility,
    ...(promptContentRows !== undefined ? { promptContentRows } : {}),
  });

  // OpenTUI class constructors expect the full RenderContext (CliRenderer).
  const ctx = renderer as CliRenderer;

  const root = new BoxRenderable(ctx, {
    id: "app-shell",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: "#1a1b26",
  });

  const headerBox = new BoxRenderable(ctx, {
    id: "shell-header",
    width: "100%",
    height: Math.max(1, layout.heights.header),
    flexShrink: 0,
    backgroundColor: "#3d59a1",
    paddingLeft: 0,
  });
  const header = new TextRenderable(ctx, {
    id: "shell-header-text",
    content: ` ${title}`,
    fg: "#c0caf5",
  });
  headerBox.add(header);

  const transcript = new ScrollBoxRenderable(ctx, {
    id: "shell-transcript",
    width: "100%",
    height: Math.max(1, layout.heights.transcript),
    flexShrink: 0,
    stickyScroll: true,
    stickyStart: "bottom",
    scrollY: true,
    focusable: true,
    rootOptions: { backgroundColor: "#1a1b26" },
    contentOptions: { backgroundColor: "#1a1b26" },
    viewportOptions: { backgroundColor: "#1a1b26" },
  });

  // Prompt zone: constitution base is 3 rows (bordered). Input is one content line.
  const promptBox = new BoxRenderable(ctx, {
    id: "shell-prompt-region",
    width: "100%",
    height: Math.max(1, layout.heights.prompt),
    flexShrink: 0,
    flexDirection: "column",
    border: true,
    borderColor: "#414868",
    focusedBorderColor: "#7aa2f7",
    backgroundColor: "#24283b",
    paddingLeft: 1,
    paddingRight: 1,
  });
  const prompt = new InputRenderable(ctx, {
    id: "shell-prompt",
    width: "100%",
    placeholder: "message…",
    backgroundColor: "#24283b",
    focusedBackgroundColor: "#414868",
    textColor: "#c0caf5",
    cursorColor: "#7aa2f7",
    placeholderColor: "#565f89",
  });
  promptBox.add(prompt);

  const statusBox = new BoxRenderable(ctx, {
    id: "shell-status",
    width: "100%",
    height: Math.max(1, layout.heights.status),
    flexShrink: 0,
    backgroundColor: "#9ece6a",
  });
  const status = new TextRenderable(ctx, {
    id: "shell-status-text",
    content: " FOLLOW · queue 0 · focus prompt · lines 0",
    fg: "#1a1b26",
  });
  statusBox.add(status);

  root.add(headerBox);
  root.add(transcript);
  root.add(promptBox);
  root.add(statusBox);

  if (mount) {
    renderer.root.add(root);
  }

  let disposed = false;
  const onKey = (key: KeyEvent): void => {
    if (disposed) return;
    if (key.name === "tab" && !key.ctrl && !key.meta && !key.option) {
      key.preventDefault();
      toggleShellFocus(shell);
    }
  };
  const onResize = (width: number, height: number): void => {
    if (disposed) return;
    relayout(shell, { columns: width, rows: height });
  };

  if (wireKeys) {
    renderer.keyInput.on("keypress", onKey);
  }
  renderer.on(CliRenderEvents.RESIZE, onResize);

  const shell: AppShell = {
    renderer,
    root,
    header,
    headerBox,
    transcript,
    prompt,
    promptBox,
    status,
    statusBox,
    layout,
    focus: createFocusState(),
    pendingQueue: Math.max(0, Math.floor(options?.pendingQueue ?? 0)),
    lineCount: 0,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (wireKeys) {
        renderer.keyInput.off("keypress", onKey);
      }
      renderer.off(CliRenderEvents.RESIZE, onResize);
      try {
        renderer.root.remove(root);
      } catch {
        // Root may already be torn down in tests.
      }
      root.destroy();
    },
  };

  internals.set(shell, { visibility, promptContentRows });
  applyLayout(shell, layout);
  applyFocus(shell);
  return shell;
}
