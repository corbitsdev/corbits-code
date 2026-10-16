/**
 * Director card composition. Cards are built here from the shared fragments;
 * agent prompt modules only call the composed card. There is no second copy
 * of the card text.
 */

export {
  DISPATCH_ROUTE_ROWS,
  REPORT_ENVELOPE_SHAPE,
  dispatchRouteSection,
  doneGate,
  identityLine,
  outOfLane,
} from "./fragments.js";

export {
  DIRECTOR_CARDS,
  artistCard,
  coderCard,
  designerCard,
  dispatchCard,
  explorerCard,
  plannerCard,
  proberCard,
  qaLeadCard,
  reviewerCard,
  shakespeareCard,
  wardenCard,
} from "./cards.js";
