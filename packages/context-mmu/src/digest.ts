// Deterministic digest placeholder for a page that is not materialized in
// the model context. The string is a pure function of the page's identity
// fields, so the same page always renders the same placeholder — across
// turns, handles and MMU instances — and different pages never collide on
// the truncated digest except with negligible probability.

export interface PageDigestInfo {
  sha256: string;
  mime: string;
  width?: number;
  height?: number;
}

/**
 * Renders the placeholder pinned by the durable-core spec:
 * `[image sha256:ab12… WxH mime — recall(handle) чтобы увидеть]` where
 * `ab12…` is the first hex quartet of the digest and `WxH` collapses to
 * `?x?` when the intrinsic dimensions are unknown.
 */
export function formatPageDigest(info: PageDigestInfo): string {
  const shortDigest = info.sha256.slice(0, 4);
  const dimensions =
    info.width !== undefined && info.height !== undefined
      ? `${info.width}x${info.height}`
      : '?x?';
  return `[image sha256:${shortDigest}… ${dimensions} ${info.mime} — recall(handle) чтобы увидеть]`;
}
