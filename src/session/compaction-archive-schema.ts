import { type } from "arktype";

export const ArchiveKind = type(
  "'user_message' | 'assistant_text' | 'tool_args' | 'tool_result' | 'overflow_blob' | 'attachment' | 'tool_failure'",
);
export type ArchiveKind = typeof ArchiveKind.infer;

export const ToolRecordingLifecycle = type(
  "'requested' | 'suspended' | 'denied' | 'admitted'",
);
export type ToolRecordingLifecycle = typeof ToolRecordingLifecycle.infer;

export const ArchiveOccurrence = type({
  occurrenceId: "string",
  sessionId: "string",
  kind: ArchiveKind,
  contentHash: "string",
  blobKey: "string",
  recordedAt: "number",
  "callId?": "string",
  "lifecycle?": ToolRecordingLifecycle,
  "provenance?": "string",
  "gap?": "boolean",
});
export type ArchiveOccurrence = typeof ArchiveOccurrence.infer;

export const CompletenessCertificate = type({
  status: "'complete' | 'incomplete'",
  expectedOccurrenceIds: "string[]",
  presentOccurrenceIds: "string[]",
  missingOccurrenceIds: "string[]",
  unverifiedBlobIds: "string[]",
  certifiedAt: "number",
});
export type CompletenessCertificate = typeof CompletenessCertificate.infer;

export const HistoricalImportResult = type({
  importedOccurrenceIds: "string[]",
  gapOccurrenceIds: "string[]",
});
export type HistoricalImportResult = typeof HistoricalImportResult.infer;
