import { META_AUTH_HOST } from "@corbits/meta-provider";

const META_AUTH_HOSTNAME = new URL(META_AUTH_HOST).hostname;

export const REJECTED_META_VERIFICATION_URI = "rejected verification url";

/** https on Meta's auth host only. The device-flow package allows any http(s) URL. */
export function isPinnedMetaVerificationUri(uri: string): boolean {
  try {
    const url = new URL(uri);
    return url.protocol === "https:" && url.hostname === META_AUTH_HOSTNAME;
  } catch {
    return false;
  }
}
