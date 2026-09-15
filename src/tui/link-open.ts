/**
 * Opening: the openable-URL gate plus the browser opener behind it.
 *
 * openUrl is the single opener choke point: every armed-row and markdown
 * release path opens through it, and its isOpenableUrl check is the gate
 * that decides. The isOpenableUrl pre-filters in linkColumnHits and
 * followWrapChain stay as defense-in-depth — they keep non-http(s) targets
 * out of highlight and wrap-fusion geometry — and are deliberately not
 * consolidated into this one call site.
 */
import type { MouseEvent } from "@opentui/core";

/**
 * Only http(s) targets ever open. Markdown authors can point a link at any
 * scheme (`javascript:`, `file:`, `mailto:`), so the gate parses rather than
 * prefix-matching.
 */
export function isOpenableUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export type UrlOpener = (url: string) => void;

/**
 * Argv for opening a URL with the platform handler, without a shell. Windows
 * must never route through `cmd /c start`: cmd.exe re-parses the assembled
 * command line, so `&`, `|` and `&&` in an attacker-influenceable transcript
 * URL would execute as command separators. `rundll32 url.dll,FileProtocolHandler`
 * takes the URL as a plain argv element instead.
 */
export function platformUrlCommand(platform: string, url: string): string[] {
  if (platform === "darwin") return ["open", url];
  if (platform === "win32")
    return ["rundll32", "url.dll,FileProtocolHandler", url];
  return ["xdg-open", url];
}

/**
 * The open gesture: left press while Ctrl is held. Cmd on macOS is the
 * terminal's own OSC-8 click (it handles Cmd+click itself and the app never
 * sees the press); Ctrl is what SGR mouse reports carry on every platform.
 */
export function isUrlOpenClick(
  event: Pick<MouseEvent, "button" | "modifiers">,
): boolean {
  return event.button === 0 && event.modifiers.ctrl === true;
}

function defaultUrlOpener(url: string): void {
  const command = platformUrlCommand(process.platform, url);
  try {
    Bun.spawn(command, {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    }).unref();
  } catch {
    // Fire-and-forget from a hover/click handler with no status line to
    // report to; a missing opener must not break the transcript.
  }
}

let currentOpener: UrlOpener = defaultUrlOpener;

/** Test seam: swap the browser opener, `resetUrlOpener` restores it. */
export function setUrlOpener(opener: UrlOpener): void {
  currentOpener = opener;
}

export function resetUrlOpener(): void {
  currentOpener = defaultUrlOpener;
}

/** Open an http(s) URL in the default browser; anything else is ignored. */
export function openUrl(url: string): void {
  if (!isOpenableUrl(url)) return;
  try {
    currentOpener(url);
  } catch {
    // Same fire-and-forget contract as the default opener above.
  }
}
