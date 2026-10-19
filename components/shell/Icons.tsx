// Line icons, path data copied from the Element design files (24x24 viewBox,
// round caps and joins). Info and Document are drawn in the same style because
// the designs have no About or filing icon.

import type { ReactNode } from 'react';
import { Platform } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

interface IconProps {
  color: string;
  size?: number;
  strokeWidth?: number;
}

// Icons are decorative. On web, react-native-svg renders a plain <svg>, which
// only understands aria-hidden; the native props would end up in the DOM.
const hiddenFromScreenReaders =
  Platform.OS === 'web'
    ? ({ 'aria-hidden': true } as object)
    : { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const };

function Icon({ color, size = 24, strokeWidth = 1.8, children }: IconProps & { children: ReactNode }) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...hiddenFromScreenReaders}
    >
      {children}
    </Svg>
  );
}

export function FeedIcon(p: IconProps) {
  return (
    <Icon strokeWidth={1.9} {...p}>
      <Rect x={4} y={4} width={16} height={11} rx={2.5} />
      <Path d="M7 19h10" />
    </Icon>
  );
}

// Bar chart: the design's "New data" icon, also used for the Numbers nav item.
export function NumbersIcon(p: IconProps) {
  return (
    <Icon strokeWidth={2} {...p}>
      <Path d="M4 20V10M10 20V4M16 20v-8M22 20H2" />
    </Icon>
  );
}

export function InfoIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <Circle cx={12} cy={12} r={9} />
      <Path d="M12 11v6M12 7.5v.01" />
    </Icon>
  );
}

export function LinkIcon(p: IconProps) {
  return (
    <Icon size={18} {...p}>
      <Path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <Path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1" />
    </Icon>
  );
}

export function ExternalIcon(p: IconProps) {
  return (
    <Icon size={18} strokeWidth={2} {...p}>
      <Path d="M14 4h6v6" />
      <Path d="M20 4l-9 9" />
      <Path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </Icon>
  );
}

export function SparkleIcon(p: IconProps) {
  return (
    <Icon size={14} strokeWidth={2} {...p}>
      <Path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
    </Icon>
  );
}

export function ChevronUpIcon(p: IconProps) {
  return (
    <Icon size={16} strokeWidth={2} {...p}>
      <Path d="M6 14l6-6 6 6" />
    </Icon>
  );
}

export function CloseIcon(p: IconProps) {
  return (
    <Icon size={18} strokeWidth={2} {...p}>
      <Path d="M6 6l12 12M18 6L6 18" />
    </Icon>
  );
}

// Government building: the design's icon for the Federal Reserve source tile.
export function BuildingIcon(p: IconProps) {
  return (
    <Icon size={22} {...p}>
      <Path d="M3 10l9-6 9 6" />
      <Path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 21h18" />
    </Icon>
  );
}

// Filing / document (same stroke style; the designs have no filing icon).
export function DocumentIcon(p: IconProps) {
  return (
    <Icon size={22} {...p}>
      <Path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <Path d="M14 3v5h5M9 13h6M9 17h4" />
    </Icon>
  );
}

// Person: the design's "Me" icon, used for the Account nav item.
export function PersonIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <Circle cx={12} cy={8} r={4} />
      <Path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" />
    </Icon>
  );
}

// Thumbs for "More like this" / "Less like this" (same stroke style as the design icons).
const THUMB = 'M7 11l4-7a2 2 0 0 1 3.4 1.9L13.6 10H19a2 2 0 0 1 2 2.4l-1.3 6A2 2 0 0 1 17.7 20H7z';

export function ThumbUpIcon(p: IconProps) {
  return (
    <Icon size={18} {...p}>
      <Path d="M3 11h4v9H3z" />
      <Path d={THUMB} />
    </Icon>
  );
}

export function ThumbDownIcon(p: IconProps) {
  return (
    <Icon size={18} {...p}>
      <Path d="M3 11h4v9H3z" transform="rotate(180 12 12)" />
      <Path d={THUMB} transform="rotate(180 12 12)" />
    </Icon>
  );
}

// Share, path data from Mobile-Final / Web-Final.
export function ShareIcon(p: IconProps) {
  return (
    <Icon size={22} {...p}>
      <Path d="M12 15V3" />
      <Path d="M7 8l5-5 5 5" />
      <Path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />
    </Icon>
  );
}


// Eye / eye-off for the show-password toggle (same stroke style as the design icons).
const EYE = 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z';

export function EyeIcon(p: IconProps) {
  return (
    <Icon size={20} {...p}>
      <Path d={EYE} />
      <Circle cx={12} cy={12} r={3} />
    </Icon>
  );
}

export function EyeOffIcon(p: IconProps) {
  return (
    <Icon size={20} {...p}>
      <Path d={EYE} />
      <Circle cx={12} cy={12} r={3} />
      <Path d="M3 3l18 18" />
    </Icon>
  );
}

// Previous / next arrows for the trends card (design Web-Final).
export function ChevronLeftIcon(p: IconProps) {
  return (
    <Icon size={18} strokeWidth={2} {...p}>
      <Path d="M15 6l-6 6 6 6" />
    </Icon>
  );
}

export function ChevronRightIcon(p: IconProps) {
  return (
    <Icon size={18} strokeWidth={2} {...p}>
      <Path d="M9 6l6 6-6 6" />
    </Icon>
  );
}

// Bottom-bar icons for Brief, Search and Following (design Mobile-Final nav).
export function BriefIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <Circle cx={12} cy={12} r={4} />
      <Path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </Icon>
  );
}

export function SearchIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <Circle cx={11} cy={11} r={6.5} />
      <Path d="M16 16l4.5 4.5" />
    </Icon>
  );
}

// Pulse line: Following tab and the card's "Follow this story" button.
export function PulseIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <Path d="M3 12h4l3-7 4 14 3-7h4" />
    </Icon>
  );
}
