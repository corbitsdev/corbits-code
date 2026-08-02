import type { PendingImageAttachment } from "./image-attachments.js";

export type OutboundUserMessage = {
  text: string;
  attachments: PendingImageAttachment[];
};
