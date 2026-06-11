import { spawn } from "node:child_process";

// Wrap text in an OSC 8 hyperlink so terminals that support it render `label` as
// a clickable link to `url`. Terminals without OSC 8 support just show `label`.
export function osc8(url: string, label: string): string {
  return `]8;;${url}${label}]8;;`;
}

// Copy text to the system clipboard. OSC 52 works over most modern terminals
// (including remote sessions) without spawning anything; on darwin we also pipe
// to pbcopy as a fallback for terminals that disable OSC 52.
export function writeClipboard(text: string): void {
  const base64 = Buffer.from(text, "utf8").toString("base64");
  process.stdout.write(`]52;c;${base64}`);

  if (process.platform === "darwin") {
    try {
      const child = spawn("pbcopy");
      child.on("error", () => undefined);
      child.stdin.end(text);
    } catch {
      // OSC 52 already attempted; ignore pbcopy failure.
    }
  }
}
