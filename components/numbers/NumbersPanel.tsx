// "Numbers to know" rows. Full variant: the Numbers screen (one card per number,
// with a plain-language line). Compact variant: the desktop right rail.

import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { AppConfig, MacroFact } from '../../contract/types.ts';
import type { Api } from '../../lib/api/api.ts';
import { changeText, factA11yLabel, shortDate } from '../../lib/shared/format';
import { withToneLabel } from '../../lib/numbers/numberTone';
import { noticesFor } from '../../lib/shared/labels';
import { plainExplainer } from '../../lib/numbers/seriesCopy';
import { usePalette } from '../../lib/theme/useTheme';
import { userMessage } from '../../lib/api/errors';
import { fonts } from '../../lib/theme/theme';
import { changeColor } from '../card/DataCard';
import { openUrl } from '../card/SourceChip';
import { EmptyState, ErrorState, LoadingState } from '../shell/States';

export function useNumbers(api: Api) {
  const [facts, setFacts] = useState<MacroFact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    setError(null);
    api
      .numbersToKnow()
      .then((f) => alive && setFacts(f))
      .catch((e: unknown) => alive && setError(userMessage(e, 'Could not load numbers.')));
    return () => {
      alive = false;
    };
  }, [api, attempt]);
  return { facts, error, retry: () => setAttempt((n) => n + 1) };
}

function when(f: MacroFact): string {
  return f.period ?? `As of ${shortDate(f.as_of)}`;
}

interface Props {
  api: Api;
  config: AppConfig | null;
  variant: 'full' | 'compact';
}

export function NumbersPanel({ api, config, variant }: Props) {
  const p = usePalette();
  const { facts, error, retry } = useNumbers(api);
  const notices = noticesFor(config, 'numbers_panel');

  if (error) return <ErrorState title="Could not load the numbers" message={error} onRetry={retry} />;
  if (!facts) return <LoadingState />;
  if (facts.length === 0) return <EmptyState message="No numbers yet. Check back soon." />;

  const noticeEls = notices.map((n) => (
    <Text
      key={n.key}
      style={[styles.notice, { color: p.muted }]}
      onPress={n.url ? () => openUrl(n.url as string) : undefined}
      accessibilityRole={n.url ? 'link' : 'text'}
    >
      {n.text}
    </Text>
  ));

  if (variant === 'compact') {
    return (
      <View>
        {facts.map((f) => (
          <Pressable
            key={f.series_id}
            onPress={() => openUrl(f.source_url)}
            accessibilityRole="link"
            accessibilityLabel={withToneLabel(factA11yLabel(f), f.series_id, f.direction)}
            style={({ pressed }) => [styles.cRow, { borderTopColor: p.rowDivider, opacity: pressed ? 0.75 : 1 }]}
          >
            <View style={styles.cLeft}>
              <Text style={[styles.cLabel, { color: p.ink }]}>{f.label}</Text>
              <Text style={[styles.cSource, { color: p.muted }]}>
                {f.source_short} · {when(f)}
              </Text>
            </View>
            <View style={styles.cRight}>
              <Text style={[styles.cValue, { color: p.ink }]}>{f.value}</Text>
              {changeText(f) ? <Text style={[styles.cChange, { color: changeColor(p, f) }]}>{changeText(f)}</Text> : null}
            </View>
          </Pressable>
        ))}
        <View style={styles.cNotices}>{noticeEls}</View>
      </View>
    );
  }

  return (
    <View style={styles.fullList}>
      {facts.map((f) => {
        const plain = plainExplainer(f.series_id);
        return (
          <Pressable
            key={f.series_id}
            onPress={() => openUrl(f.source_url)}
            accessibilityRole="link"
            accessibilityLabel={withToneLabel(factA11yLabel(f), f.series_id, f.direction)}
            style={({ pressed }) => [styles.fRow, { backgroundColor: p.surface, borderColor: p.border, opacity: pressed ? 0.8 : 1 }]}
          >
            <View style={styles.fLeft}>
              <Text style={[styles.fLabel, { color: p.ink }]}>{f.label}</Text>
              {plain ? <Text style={[styles.fPlain, { color: p.inkPlain }]}>{plain}</Text> : null}
              <Text style={[styles.fSource, { color: p.muted }]}>
                {f.source_short} · {when(f)}
              </Text>
            </View>
            <View style={styles.fRight}>
              <Text style={[styles.fValue, { color: p.ink }]}>{f.value}</Text>
              {changeText(f) ? <Text style={[styles.fChange, { color: changeColor(p, f) }]}>{changeText(f)}</Text> : null}
            </View>
          </Pressable>
        );
      })}
      {noticeEls}
      <Text style={[styles.notice, { color: p.muted }]}>Tap a number to open the original data series.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  notice: { fontFamily: fonts.sans, fontSize: 12, lineHeight: 17 },
  // compact (right rail)
  cRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    minHeight: 44,
    paddingVertical: 8,
    borderTopWidth: 1,
  },
  cLeft: { flexShrink: 1 },
  cLabel: { fontFamily: fonts.sansSemi, fontSize: 15 },
  cSource: { fontFamily: fonts.sans, fontSize: 12 },
  cRight: { alignItems: 'flex-end' },
  cValue: { fontFamily: fonts.serif, fontSize: 22, lineHeight: 24 },
  cChange: { fontFamily: fonts.sansSemi, fontSize: 12 },
  cNotices: { paddingTop: 8, gap: 4 },
  // full (Numbers screen)
  fullList: { gap: 10 },
  fRow: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderRadius: 18, paddingVertical: 14, paddingHorizontal: 16 },
  fLeft: { flex: 1, gap: 2, minWidth: 0 },
  fLabel: { fontFamily: fonts.sansSemi, fontSize: 16 },
  fPlain: { fontFamily: fonts.sans, fontSize: 14, lineHeight: 19 },
  fSource: { fontFamily: fonts.sans, fontSize: 12 },
  fRight: { alignItems: 'flex-end', gap: 2 },
  fValue: { fontFamily: fonts.serif, fontSize: 30, lineHeight: 32, letterSpacing: -0.3 },
  fChange: { fontFamily: fonts.sansSemi, fontSize: 13 },
});
