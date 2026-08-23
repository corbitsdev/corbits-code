// Dynamic layout primitives for the `present` tool. The agent (or MCP converters)
// composes output using only these; there are no named semantic widgets (no
// "card", "table", "badge", "list", etc). Layout is fully under the caller's
// control so structures are not hardcoded in the contract.
//
// Every node produces a predictable number of visual lines for a given width,
// which the event log uses for scrolling and slicing.

export type Tone = "default" | "muted" | "success" | "warning" | "danger" | "accent";

export type ViewNode =
  | { type: "text"; text: string; tone?: Tone; bold?: boolean; dim?: boolean }
  | { type: "stack"; children: ViewNode[]; gap?: 0 | 1 }
  | { type: "row"; children: ViewNode[]; gap?: 0 | 1 }
  | { type: "box"; border?: boolean; padding?: 0 | 1; children: ViewNode[] }
  | { type: "divider" }
  // grid provides column alignment across rows (the only collective layout op
  // needed because terminals are a grid). Each cell is a sub-ViewNode (usually
  // a text). The renderer allocates widths and renders cells left-to-right.
  | {
      type: "grid";
      // per-column hints (optional); omitted columns default to left.
      columns?: { align?: "left" | "right" | "center" }[];
      rows: ViewNode[][];
    };

export type ViewNodeType = ViewNode["type"];

// Bounds protect the renderer (and the token bill) from pathological specs.
export const VIEW_MAX_NODES = 500;
export const VIEW_MAX_DEPTH = 8;
export const VIEW_GRID_MAX_ROWS = 200;
