// Generative-UI view spec: a serializable tree of building-block nodes the agent
// (or a deterministic converter) emits, rendered by a trusted Ink interpreter.
// Modeled on vercel-labs/json-render (catalog -> registry -> spec -> renderer).
//
// v1 is intentionally VERTICAL ONLY. Every node's painted height must be exactly
// predictable from its width so it fits the event log's line-based scroll model;
// a horizontal `columns` container is deferred until renderer and height share a
// single width-allocation function. Keep this palette small and version it
// deliberately — the agent learns to target these types.

export type Tone = "default" | "muted" | "success" | "warning" | "danger" | "accent";

export type ViewColumn = {
  header: string;
  field: string;
  align?: "left" | "right";
  // "status"/"priority" auto-color the cell by its value; a Tone forces a color.
  colorRole?: Tone | "status" | "priority";
};

export type KeyValuePair = { label: string; value: string; tone?: Tone };

export type ViewNode =
  | { type: "text"; value: string; tone?: Tone; bold?: boolean; dim?: boolean }
  | { type: "heading"; value: string; level?: 1 | 2 | 3 }
  | { type: "badge"; label: string; tone?: Tone }
  | { type: "divider" }
  | { type: "progress"; value: number; max?: number; label?: string }
  | { type: "keyValue"; pairs: KeyValuePair[] }
  | { type: "list"; ordered?: boolean; items: string[] }
  | { type: "table"; columns: ViewColumn[]; rows: Record<string, string>[] }
  | {
      type: "card";
      title?: string;
      subtitle?: string;
      fields: KeyValuePair[];
      badges?: { label: string; tone?: Tone }[];
    }
  | { type: "stack"; gap?: 0 | 1; children: ViewNode[] };

export type ViewNodeType = ViewNode["type"];

// Bounds protect the renderer (and the token bill) from pathological specs.
export const VIEW_MAX_NODES = 500;
export const VIEW_MAX_DEPTH = 8;
export const VIEW_TABLE_MAX_ROWS = 200;
