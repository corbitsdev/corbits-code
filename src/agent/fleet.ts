/**
 * Fleet barrel (CL-9808, PR #1352): one import site for the closed director fleet.
 *
 * Re-exports the six-name surface per @corbits/code-agent-<id> workspace package,
 * plus a FLEET registry keyed by id over each package's director. Re-export only —
 * never in-tree ./directors/* (the merge-order stale re-export hazard).
 *
 * All 10 @corbits/code-agent-<id> packages have merged; `tsconfig` `paths`
 * aliases resolve each name to the real agents/<id>/src/index.ts package entry.
 */

// Workspace packages — six-name surface each.
import {
  agent as artistAgent,
  config as artistConfig,
  defineAgent as defineArtistAgent,
  director as artistDirector,
  systemPrompt as artistSystemPrompt,
  tools as artistTools,
} from "@corbits/code-agent-artist";
import {
  agent as coderAgent,
  config as coderConfig,
  defineAgent as defineCoderAgent,
  director as coderDirector,
  systemPrompt as coderSystemPrompt,
  tools as coderTools,
} from "@corbits/code-agent-coder";
import {
  agent as designerAgent,
  config as designerConfig,
  defineAgent as defineDesignerAgent,
  director as designerDirector,
  systemPrompt as designerSystemPrompt,
  tools as designerTools,
} from "@corbits/code-agent-designer";
import {
  agent as dispatchAgent,
  config as dispatchConfig,
  defineAgent as defineDispatchAgent,
  director as dispatchDirector,
  systemPrompt as dispatchSystemPrompt,
  tools as dispatchTools,
} from "@corbits/code-agent-dispatch";
import {
  agent as explorerAgent,
  config as explorerConfig,
  defineAgent as defineExplorerAgent,
  director as explorerDirector,
  systemPrompt as explorerSystemPrompt,
  tools as explorerTools,
} from "@corbits/code-agent-explorer";
import {
  agent as plannerAgent,
  config as plannerConfig,
  defineAgent as definePlannerAgent,
  director as plannerDirector,
  systemPrompt as plannerSystemPrompt,
  tools as plannerTools,
} from "@corbits/code-agent-planner";
import {
  agent as proberAgent,
  config as proberConfig,
  defineAgent as defineProberAgent,
  director as proberDirector,
  systemPrompt as proberSystemPrompt,
  tools as proberTools,
} from "@corbits/code-agent-prober";
import {
  agent as reviewerAgent,
  config as reviewerConfig,
  defineAgent as defineReviewerAgent,
  director as reviewerDirector,
  systemPrompt as reviewerSystemPrompt,
  tools as reviewerTools,
} from "@corbits/code-agent-reviewer";
import {
  agent as shakespeareAgent,
  config as shakespeareConfig,
  defineAgent as defineShakespeareAgent,
  director as shakespeareDirector,
  systemPrompt as shakespeareSystemPrompt,
  tools as shakespeareTools,
} from "@corbits/code-agent-shakespeare";
import {
  agent as wardenAgent,
  config as wardenConfig,
  defineAgent as defineWardenAgent,
  director as wardenDirector,
  systemPrompt as wardenSystemPrompt,
  tools as wardenTools,
} from "@corbits/code-agent-warden";

// Fleet registry — keyed by id, one director per workspace package.
export const FLEET = {
  artist: artistDirector,
  coder: coderDirector,
  designer: designerDirector,
  dispatch: dispatchDirector,
  explorer: explorerDirector,
  planner: plannerDirector,
  prober: proberDirector,
  reviewer: reviewerDirector,
  shakespeare: shakespeareDirector,
  warden: wardenDirector,
} as const;

// Re-exports — six-name surface per package.
export {
  artistAgent,
  artistConfig,
  artistDirector,
  artistSystemPrompt,
  artistTools,
  coderAgent,
  coderConfig,
  coderDirector,
  coderSystemPrompt,
  coderTools,
  defineArtistAgent,
  defineCoderAgent,
  defineDesignerAgent,
  defineDispatchAgent,
  defineExplorerAgent,
  definePlannerAgent,
  defineProberAgent,
  defineReviewerAgent,
  defineShakespeareAgent,
  defineWardenAgent,
  designerAgent,
  designerConfig,
  designerDirector,
  designerSystemPrompt,
  designerTools,
  dispatchAgent,
  dispatchConfig,
  dispatchDirector,
  dispatchSystemPrompt,
  dispatchTools,
  explorerAgent,
  explorerConfig,
  explorerDirector,
  explorerSystemPrompt,
  explorerTools,
  plannerAgent,
  plannerConfig,
  plannerDirector,
  plannerSystemPrompt,
  plannerTools,
  proberAgent,
  proberConfig,
  proberDirector,
  proberSystemPrompt,
  proberTools,
  reviewerAgent,
  reviewerConfig,
  reviewerDirector,
  reviewerSystemPrompt,
  reviewerTools,
  shakespeareAgent,
  shakespeareConfig,
  shakespeareDirector,
  shakespeareSystemPrompt,
  shakespeareTools,
  wardenAgent,
  wardenConfig,
  wardenDirector,
  wardenSystemPrompt,
  wardenTools,
};
