// OSC 8 hyperlinks (https://gist.github.com/egmontkob/eb114294efbcd5adb1944c9f3cb5feda).
// BEL (\x07) terminator is widely supported; ST (\x1b\\) is the alternate.
// Reject control characters in the URL so a hostile label/url cannot break out
// of the sequence or inject arbitrary CSI into the terminal.

const CONTROL_OR_BEL = /[\x00-\x1f\x7f]/;

export function isSafeOsc8Url(url: string): boolean {
  if (url.length === 0 || url.length > 2048) return false;
  if (CONTROL_OR_BEL.test(url)) return false;
  // Allow absolute http(s) and relative-ish paths/fragments used in docs.
  return /^(https?:\/\/|mailto:|file:|\/|\.\/|#)/i.test(url) || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url);
}

export function osc8Hyperlink(url: string, label: string): string {
  if (!isSafeOsc8Url(url)) return label;
  // Strip controls from the visible label so they never paint raw.
  const safeLabel = label.replace(CONTROL_OR_BEL, "");
  return `\x1b]8;;${url}\x07${safeLabel}\x1b]8;;\x07`;
}
