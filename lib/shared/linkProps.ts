// Props that make a Pressable or Text a real link. On the web: a genuine <a href target=_blank
// rel="noopener noreferrer"> (right-click, middle-click, copy link, crawlers and screen readers all
// work) whose press only records the open; the browser itself navigates. On phones: no href,
// press opens the URL through Linking. Non-https URLs get no link at all. Pure (the platform and
// both actions are passed in), so Node tests cover it; the app wrapper is `linkProps` in openUrl.ts.

import { isOpenableUrl } from './safeUrl.ts';

export interface LinkProps {
  href?: string;
  hrefAttrs?: { target: '_blank'; rel: 'noopener noreferrer' };
  onPress: () => void;
}

export function buildLinkProps(url: string, web: boolean, actions: { track: () => void; open: () => void }): LinkProps | null {
  if (!isOpenableUrl(url)) return null;
  if (web) return { href: url, hrefAttrs: { target: '_blank', rel: 'noopener noreferrer' }, onPress: actions.track };
  return { onPress: actions.open };
}
