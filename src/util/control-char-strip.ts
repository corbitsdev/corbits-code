// Strip terminal control sequences from untrusted text before it can reach the
// renderer. A compromised MCP server, a tool reading attacker-controlled file
// content, or a model reproducing an injected payload in its own reply can
// return bytes that, if painted raw, move the cursor, rewrite the scrollback,
// or fire OSC 52 clipboard/OSC 8 hyperlink side effects. Such text is rendered
// as plain text, so none of this is "intentionally-emitted styling" — that only
// happens in the app's own renderer layer (see src/tui/osc8.ts), which this
// sanitizer never touches.

// String-type sequences (OSC, DCS, PM, APC) run until the ST terminator
// (ESC \) or, conventionally for OSC, BEL (\u0007).
const STRING_SEQUENCE = /\u001b[\]P^_][\s\S]*?(?:\u0007|\u001b\\)/g;

// An unterminated string sequence never ends, so its payload would otherwise
// leak as visible text once the introducer bytes are stripped, and a terminator
// arriving from a later concatenation would arm it. Drop it through end of text.
const UNTERMINATED_STRING_SEQUENCE = /\u001b[\]P^_][\s\S]*$/;

// CSI: ESC [, parameter bytes 0x30-0x3F, intermediate bytes 0x20-0x2F, final
// byte 0x40-0x7E.
const CSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

// Remaining two-byte Fe escape sequences (cursor save/restore, charset
// select, RIS, etc.) not already covered above.
const OTHER_ESCAPE = /\u001b[0-9A-Za-z=><]/g;

// Bidirectional overrides and isolates (Trojan Source). These reorder the
// glyphs a reader sees without changing the underlying bytes, so a filename or
// a command in a permission approval overlay can read as one thing and run as
// another. They are removed outright rather than replaced with a visible
// marker: the reordering is the payload, so deleting it restores agreement
// between logical order and painted order, which is exactly what the operator
// must be able to trust. A marker would preserve the deception risk by
// tempting the reader to mentally re-insert what was removed.
const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/g;

// U+2028/U+2029 are not "\n", so line-count math ignores them while some
// renderers break lines on them — computed height then disagrees with painted
// height. Normalizing to a space keeps the character count of the row honest.
const LINE_PARAGRAPH_SEPARATORS = /[\u2028\u2029]/g;

// C0 controls other than the whitespace worth keeping (tab, newline,
// carriage return), plus the C1 range and the standalone DEL byte.
const C0_C1_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0080-\u009f]/g;

export function stripTerminalControlSequences(text: string): string {
  return text
    .replace(STRING_SEQUENCE, "")
    .replace(UNTERMINATED_STRING_SEQUENCE, "")
    .replace(CSI_SEQUENCE, "")
    .replace(OTHER_ESCAPE, "")
    .replace(BIDI_CONTROLS, "")
    .replace(LINE_PARAGRAPH_SEPARATORS, " ")
    .replace(C0_C1_CONTROLS, "");
}

// A complete escape sequence anchored at the start of the text.
const COMPLETE_SEQUENCE_AT_START =
  /^(?:\u001b[\]P^_][\s\S]*?(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[0-9A-Za-z=><])/;

// Beyond this, a "sequence" is treated as junk and sanitized rather than held:
// an unterminated OSC must not let an attacker buffer the transcript forever.
const MAX_HELD_CHARS = 256;

/**
 * Split streamed text into the part safe to sanitize now and a tail that may
 * still be the beginning of something. Sanitizing stream fragments
 * independently would miss an escape sequence straddling a fragment boundary,
 * so the tail is carried into the next fragment instead.
 */
export function splitPendingControlTail(text: string): readonly [string, string] {
  let end = text.length;
  // A lone high surrogate is half of a character; joining it to the next
  // fragment is what makes the pair render at all.
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;

  const head = text.slice(0, end);
  const escape = head.lastIndexOf("\u001b");
  if (
    escape >= 0 &&
    head.length - escape <= MAX_HELD_CHARS &&
    !COMPLETE_SEQUENCE_AT_START.test(head.slice(escape))
  ) {
    return [head.slice(0, escape), text.slice(escape)];
  }
  return [head, text.slice(end)];
}
