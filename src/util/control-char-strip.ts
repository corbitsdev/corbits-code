// Strip terminal control sequences from untrusted tool output before it can
// reach the renderer. A compromised MCP server or a tool reading attacker
// -controlled file content can return bytes that, if painted raw, move the
// cursor, rewrite the scrollback, or fire OSC 52 clipboard/OSC 8 hyperlink
// side effects. Tool results are rendered as plain text, so none of this is
// "intentionally-emitted styling" — that only happens in the app's own
// renderer layer (see src/tui/osc8.ts), which this
// sanitizer never touches.

// String-type sequences (OSC, DCS, PM, APC) run until the ST terminator
// (ESC \) or, conventionally for OSC, BEL (\x07).
const STRING_SEQUENCE = /\x1b[\]P^_][\s\S]*?(?:\x07|\x1b\\)/g;

// CSI: ESC [, parameter bytes 0x30-0x3F, intermediate bytes 0x20-0x2F, final
// byte 0x40-0x7E.
const CSI_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

// Remaining two-byte Fe escape sequences (cursor save/restore, charset
// select, RIS, etc.) not already covered above.
const OTHER_ESCAPE = /\x1b[0-9A-Za-z=><]/g;

// C0 controls other than the whitespace worth keeping (tab, newline,
// carriage return), plus the C1 range and the standalone DEL byte.
const C0_C1_CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x80-\x9f]/g;

export function stripTerminalControlSequences(text: string): string {
  return text
    .replace(STRING_SEQUENCE, "")
    .replace(CSI_SEQUENCE, "")
    .replace(OTHER_ESCAPE, "")
    .replace(C0_C1_CONTROLS, "");
}
