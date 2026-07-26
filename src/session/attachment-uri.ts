// Attachment URIs for session-local binary payloads (aged images, etc.).
// Same persistence family as tool-output spills: keys go through ContextStore
// writeBlob/readBlob. The URI is what survives in conversation turns after
// base64 is spilled out of the inference-facing context.

const ATTACHMENT_SCHEME = "attachment:";
const ATTACHMENT_URI_PREFIX = "attachment:///";

/** Marker left in place of a base64 image after aging. */
export function formatAgedImageMarker(input: {
  uri: string;
  mimeType: string;
}): string {
  return (
    `[image attachment aged: ${input.uri} mimeType=${input.mimeType} — ` +
    `rehydratable from the session store; not resent as base64]`
  );
}

export function isAttachmentUri(value: string): boolean {
  return value.startsWith(ATTACHMENT_SCHEME);
}

export function attachmentUri(id: string): string {
  const clean = id.replace(/^\/+/, "");
  return `${ATTACHMENT_URI_PREFIX}${clean}`;
}

export function parseAttachmentId(uri: string): string | undefined {
  if (!uri.startsWith(ATTACHMENT_URI_PREFIX)) return undefined;
  const id = uri.slice(ATTACHMENT_URI_PREFIX.length).split(/[/?#]/)[0] ?? "";
  return id.length > 0 ? id : undefined;
}

export type AgedImageMarker = {
  uri: string;
  id: string;
  mimeType: string;
};

/** Parse an aged-image marker, or undefined when the text is not one. */
export function parseAgedImageMarker(text: string): AgedImageMarker | undefined {
  // [image attachment aged: attachment:///ID mimeType=TYPE — ...]
  const match = text.match(
    /^\[image attachment aged: (attachment:\/\/\/[^\s]+) mimeType=([^\s]+) —/,
  );
  if (match === null) return undefined;
  const uri = match[1]!;
  const mimeType = match[2]!;
  const id = parseAttachmentId(uri);
  if (id === undefined) return undefined;
  return { uri, id, mimeType };
}

/** Content-addressed attachment id from base64 payload (stable across re-ages). */
export async function attachmentIdFromBase64(data: string): Promise<string> {
  const bytes = new TextEncoder().encode(data);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `img-${hex.slice(0, 24)}`;
}
