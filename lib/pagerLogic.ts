// Pure helpers for the vertical pager (components/FeedPager.tsx). Kept here, free of
// React/React Native imports, so the paging maths can be unit-tested.

export interface ScrollToIndexFailedInfo {
  index: number;
  highestMeasuredFrameIndex: number;
  averageItemLength: number;
}

// On a fast key-nav jump the target row may not be laid out yet, and
// FlatList.scrollToIndex throws "scrollToIndex out of range". We recover by scrolling
// to a computed offset instead. This returns that fallback offset.
//
// Prefer the real item height when we know it (every page is one full screen tall);
// otherwise fall back to FlatList's measured average. Never returns a negative offset.
export function scrollToIndexFallbackOffset(info: ScrollToIndexFailedInfo, itemHeight: number): number {
  const index = Number.isFinite(info.index) && info.index > 0 ? Math.floor(info.index) : 0;
  const height = itemHeight > 0 ? itemHeight : info.averageItemLength > 0 ? info.averageItemLength : 0;
  return index * height;
}

export function nextRevealCount(position: number, revealed: number, total: number, size = 5): number {
  return position >= revealed - 2 ? Math.min(total, revealed + size) : revealed;
}
