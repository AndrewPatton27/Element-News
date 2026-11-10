// One modal surface for every sheet and panel (detail, sources, card menu), so they all move
// the same way (ui-polish-m8):
// - phones (variant 'sheet'): the backdrop fades while the sheet rises from the bottom edge
//   (iOS sheet curve, 300 ms in, 220 ms out: exit is faster than entry). The handle and header
//   are a drag zone: the sheet follows the finger 1:1, rubber-bands if pulled up, and on release
//   closes on distance (over 30% of its height) OR a downward flick (over 0.5 px/ms), continuing
//   at the finger's speed; otherwise it springs back (damping ratio 0.8, seeded with the release
//   velocity). It can be grabbed again mid-animation.
// - wide screens (variant 'panel'): a centred panel fades and scales from 0.97 (modals stay
//   centred; nothing appears from scale 0).
// - reduced motion: opacity only, 150 ms, no slide, no spring.
// - Escape / Android back (keyboard and system actions) close instantly, never animated.
// The backdrop's opacity is derived from the same values as the sheet, so a half-dragged sheet
// has a half-faded backdrop, including mid-gesture and on reversal.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { usePalette } from '../../lib/theme/useTheme';
import { flingDuration, motion, sheetDismiss } from '../../lib/theme/motion';

interface Props {
  open: boolean;
  onClose: () => void;
  variant: 'sheet' | 'panel';
  label: string; // the dialog's accessible name
  backdropLabel: string;
  dockStyle: StyleProp<ViewStyle>; // where the surface sits (bottom dock or centred)
  surfaceStyle: StyleProp<ViewStyle>; // the surface itself (radius, padding, size)
  handle?: boolean; // phones: draw the grab handle at the top of the drag zone
  header?: ReactNode; // drag zone content under the handle (title row, close button)
  children: ReactNode;
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled?.()
      .then((v) => live && setReduced(v))
      .catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener?.('reduceMotionChanged', setReduced);
    return () => {
      live = false;
      sub?.remove?.();
    };
  }, []);
  return reduced;
}

// Pulling past the open position moves the sheet less and less (never a hard stop).
function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

export function SheetModal({ open, onClose, variant, label, backdropLabel, dockStyle, surfaceStyle, handle, header, children }: Props) {
  const p = usePalette();
  const reduced = useReducedMotion();
  const { height: windowHeight } = useWindowDimensions();
  const native = Platform.OS !== 'web';
  const progress = useRef(new Animated.Value(0)).current; // 0 closed, 1 open
  const drag = useRef(new Animated.Value(0)).current; // px pulled down from the open position
  const [mounted, setMounted] = useState(open);
  const height = useRef(windowHeight);
  const instant = useRef(false);
  const grabbed = useRef(0); // where the sheet was when the finger landed
  const live = useRef({ reduced, onClose });
  live.current = { reduced, onClose };

  // Open: mount, then rise. Close: fall (or vanish for a keyboard close), then unmount.
  useEffect(() => {
    if (open) {
      setMounted(true);
      drag.setValue(0);
      progress.stopAnimation();
      Animated.timing(progress, {
        toValue: 1,
        duration: reduced ? motion.reducedMs : variant === 'sheet' ? motion.sheetInMs : motion.panelInMs,
        easing: variant === 'sheet' && !reduced ? Easing.bezier(...motion.easeDrawer) : Easing.bezier(...motion.easeOut),
        useNativeDriver: native,
      }).start();
      return;
    }
    if (!mounted) return;
    if (instant.current) {
      instant.current = false;
      progress.setValue(0);
      setMounted(false);
      return;
    }
    Animated.timing(progress, {
      toValue: 0,
      duration: reduced ? motion.reducedMs : motion.sheetOutMs,
      easing: Easing.bezier(...motion.easeOut),
      useNativeDriver: native,
    }).start(({ finished }) => {
      if (finished) setMounted(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Not closing: spring back to fully open, seeded with the release velocity (px/s), and finish
  // the entrance if the sheet was caught while still rising.
  const settle = (vy: number) => {
    Animated.parallel([
      Animated.spring(drag, { toValue: 0, velocity: vy * 1000, ...motion.springSnap, useNativeDriver: native }),
      Animated.timing(progress, { toValue: 1, duration: motion.panelInMs, easing: Easing.bezier(...motion.easeOut), useNativeDriver: native }),
    ]).start();
  };
  const settleRef = useRef(settle);
  settleRef.current = settle;

  const responder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 6 && Math.abs(g.dy) > Math.abs(g.dx),
        onPanResponderGrant: () => {
          // Grabbed mid-animation: keep whatever is on screen and follow the finger from there.
          progress.stopAnimation();
          drag.stopAnimation((v) => {
            grabbed.current = v;
          });
        },
        onPanResponderMove: (_, g) => {
          const y = grabbed.current + g.dy;
          drag.setValue(y < 0 ? rubberband(y, height.current) : y);
        },
        onPanResponderRelease: (_, g) => {
          const y = grabbed.current + g.dy;
          const current = y < 0 ? rubberband(y, height.current) : y;
          if (sheetDismiss(current, g.vy, height.current)) {
            // Close at the finger's speed (see flingDuration).
            const ms = flingDuration(height.current - current, g.vy);
            Animated.timing(drag, { toValue: height.current, duration: ms, easing: Easing.bezier(...motion.easeOut), useNativeDriver: native }).start(({ finished }) => {
              if (!finished) return;
              progress.setValue(0);
              instant.current = true; // already off screen: the close needs no second animation
              live.current.onClose();
            });
            return;
          }
          settleRef.current(g.vy);
        },
        onPanResponderTerminate: () => settleRef.current(0),
      }),
    [drag, progress, native],
  );

  if (!mounted) return <Modal visible={false} transparent onRequestClose={onClose} />;

  const sheet = variant === 'sheet';
  const closedY = height.current || windowHeight;
  const backdropOpacity = sheet
    ? Animated.multiply(progress, drag.interpolate({ inputRange: [0, closedY], outputRange: [1, 0], extrapolate: 'clamp' }))
    : progress;
  const surfaceMotion = reduced
    ? { opacity: progress }
    : sheet
      ? { transform: [{ translateY: Animated.add(progress.interpolate({ inputRange: [0, 1], outputRange: [closedY, 0] }), drag) }] }
      : { opacity: progress, transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] }) }] };
  const dragZone = sheet && !reduced ? responder.panHandlers : {};
  const webDrag = sheet && Platform.OS === 'web' ? ({ touchAction: 'none', userSelect: 'none' } as unknown as ViewStyle) : null;

  return (
    <Modal
      visible
      transparent
      animationType="none"
      onRequestClose={() => {
        instant.current = true; // Escape / back: no animation on a keyboard or system action
        onClose();
      }}
    >
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: p.overlay, opacity: backdropOpacity }]}>
        <Pressable style={styles.fill} onPress={onClose} accessibilityLabel={backdropLabel} />
      </Animated.View>
      <View style={dockStyle} pointerEvents="box-none">
        <Animated.View
          style={[surfaceStyle, { backgroundColor: p.surface }, surfaceMotion]}
          accessibilityViewIsModal
          accessibilityLabel={label}
          role="dialog"
          aria-modal
          onLayout={(e) => {
            height.current = Math.max(1, Math.round(e.nativeEvent.layout.height));
          }}
        >
          {handle || header ? (
            <View {...dragZone} style={webDrag}>
              {handle ? <View style={[styles.handle, { backgroundColor: p.handle }]} /> : null}
              {header}
            </View>
          ) : null}
          {children}
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  handle: { alignSelf: 'center', width: 44, height: 5, borderRadius: 3, marginBottom: 2 },
});
