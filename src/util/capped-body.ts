// Shared byte-capped response-body reader.
//
// Two callers used to carry their own copy of the same subtle byte-accounting
// loop (accumulate stream chunks up to a cap, cancel the reader the moment the
// cap is exceeded so the upstream socket is not drained, concatenate, decode):
//   - web_fetch (src/tools/web-fetch.ts) caps page bodies at 5MB and error
//     snippets at 8KB, keeping the first `capBytes` bytes and flagging the cut.
//   - the OpenCode Go model catalog (src/provider/opencode-go-models.ts) caps
//     the live /models response so an oversized or hostile catalog cannot blow
//     process memory, rejecting (rather than keeping a prefix) when over.
// Keeping the reader here means a cap-accounting fix (off-by-one, cancel
// discipline, chunk slicing) lands once instead of drifting across copies.

export interface CappedBody {
  /** The body's content, decoded as UTF-8 and sliced to at most `capBytes` bytes. */
  text: string;
  /** True when the body was longer than `capBytes`; reading stopped at the cap. */
  truncated: boolean;
}

/**
 * Read up to `capBytes` bytes of a Response body. Returns the decoded prefix
 * plus whether the body was cut off; the reader is cancelled as soon as the cap
 * is exceeded so oversized bodies are not drained. A Response whose body is
 * null (synthetic responses, no-content statuses) is read via `text()` and
 * truncation is judged from the decoded byte length.
 */
export async function readCappedBody(response: Response, capBytes: number): Promise<CappedBody> {
  const body = response.body;
  if (body === null) {
    const text = await response.text();
    return {
      text,
      truncated: new TextEncoder().encode(text).byteLength > capBytes,
    };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    const remaining = capBytes - total;
    if (remaining <= 0) {
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    const slice = value.byteLength > remaining ? value.slice(0, remaining) : value;
    chunks.push(slice);
    total += slice.byteLength;
    if (slice.byteLength < value.byteLength) {
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(buffer), truncated };
}
