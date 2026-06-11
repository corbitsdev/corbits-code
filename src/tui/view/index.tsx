import { Box } from "ink";
import type { ReactNode } from "react";
import type { ViewNode } from "./spec.js";
import { renderNode } from "./registry.js";

export type { ViewNode, ViewColumn, Tone } from "./spec.js";
export { validateView, type ViewValidation } from "./validate.js";
export { viewHeight } from "./height.js";

// Render a validated view node tree. Callers validate at the boundary (use-stream
// / the MCP converter) and pass a typed node; the registry trusts it from here.
export function View({ node, columns }: { node: ViewNode; columns: number }): ReactNode {
  return <Box flexDirection="column">{renderNode(node, columns)}</Box>;
}
