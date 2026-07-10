// OSC 8 hyperlinks: terminals that support them open the URL on click.
export function osc8Hyperlink(url: string, label: string): string {
  return `\x1b]8;;${url}\x07${label}\x1b]8;;\x07`;
}