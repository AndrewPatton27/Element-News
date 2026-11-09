// Last check before a link leaves the app: only https:// URLs may be opened (no javascript:, data:, file:,
// intent: or cleartext http). Every feed-derived URL is already https-checked when parsed (types.ts isHttpUrl);
// this also covers admin-set notice and licence URLs and any future caller. Pure, so Node tests can import it.

export function isOpenableUrl(url: unknown): url is string {
  if (typeof url !== 'string' || !/^https:\/\/[^\s]+$/i.test(url)) return false;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}
