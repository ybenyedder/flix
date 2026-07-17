// Shared poster helpers for the *arr integration. Kept in one module so
// discover.ts and requests.ts (which both turn arr lookup records into DTOs)
// can never drift apart on how a poster URL is chosen or proxied.

/** Wrap a remote poster URL in the same-origin proxy (/api/arr/poster) so the
 *  CSP `img-src 'self'` holds and a malicious arr response can't be an SSRF
 *  relay (the proxy itself allowlists the host — see statusMap.isAllowedPosterUrl). */
export function proxyPoster(remote: string | null): string | null {
  return remote ? `/api/arr/poster?u=${encodeURIComponent(remote)}` : null;
}

/** Best poster URL out of an arr lookup record: an explicit `remotePoster`,
 *  else the `poster` cover image's remoteUrl/url. */
export function pickPoster(item: { remotePoster?: string; images?: { coverType?: string; remoteUrl?: string; url?: string }[] }): string | null {
  if (item.remotePoster) return item.remotePoster;
  const poster = item.images?.find((i) => i.coverType === "poster");
  return poster?.remoteUrl ?? poster?.url ?? null;
}
