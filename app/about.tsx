// About: a plain-language transparency page (designs: docs/design/mobile/Mobile-About,
// docs/design/web/Web-About). A serif lead line, small uppercase section labels,
// the sources as hairline-separated rows, a tinted disclaimer box. Where the news
// comes from, how it is collected, filtered and written, how the feeds are
// ordered, what is stored for an account, and the disclaimer.

import { useState, type ReactNode } from 'react';
import { StyleSheet, Switch, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useAppData } from '../lib/appData';
import { aiNoticeText, disclaimerText, noticesFor } from '../lib/labels';
import { APP_NAME } from '../lib/config';
import { SOURCES } from '../lib/sourcesInfo';
import { SOURCE_KEYS, toggleSource } from '../lib/sourceKeys';
import { useAccount } from '../lib/accountContext';
import { userMessage } from '../lib/errors';
import { usePalette, useWide } from '../lib/useTheme';
import { fonts, font } from '../lib/theme';
import { openUrl } from '../components/SourceChip';
import { SectionLabel } from '../components/FormParts';
import { ScreenShell } from '../components/ScreenShell';
import { AccountPrompt, DeviceData, QuickLinks } from '../components/AccountEntry';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <SectionLabel>{title}</SectionLabel>
      {children}
    </View>
  );
}

function Bullets({ items }: { items: string[] }) {
  const p = usePalette();
  const wide = useWide();
  return (
    <View style={styles.bullets}>
      {items.map((t, i) => (
        <View key={i} style={styles.bulletRow}>
          <Text style={[styles.bullet, { color: p.accent }]}>•</Text>
          <Text style={[wide ? styles.textWide : styles.text, styles.flex, { color: p.inkSoft }]}>{t}</Text>
        </View>
      ))}
    </View>
  );
}

function Link({ label, url }: { label: string; url: string }) {
  const p = usePalette();
  return (
    <Text style={[styles.link, { color: p.accentInk }]} onPress={() => openUrl(url)} accessibilityRole="link">
      {label} ↗
    </Text>
  );
}

export default function AboutScreen() {
  const p = usePalette();
  const wide = useWide();
  const { api, config } = useAppData();
  const acct = useAccount();
  const [sourceError, setSourceError] = useState<string | null>(null);
  const notices = noticesFor(config, 'about'); // FRED and CC BY-SA wording, from app_config
  const text = [wide ? styles.textWide : styles.text, { color: p.inkSoft }];

  return (
    <ScreenShell tab="about" title={`About ${APP_NAME}`} brandTitle onBack={() => router.navigate('/account' as never)}>
      <View style={[styles.column, wide && styles.columnWide]}>
        <Text style={[styles.lead, wide && styles.leadWide, { color: p.ink }]}>
          Business and market news in a few minutes, without the jargon.
        </Text>
        <Text style={text}>
          A short daily briefing in plain language: business, the economy, government, the world, science and safety. Here is exactly where it comes
          from and how it is made.
        </Text>

        <AccountPrompt />

        <Section title="How a card is made">
          <Text style={text}>
            Summary cards are written by AI from official filings and agency releases, then checked against the source. Data cards show new
            government numbers.
          </Text>
        </Section>

        <Section title="Where the news comes from">
          <Text style={text}>
            Almost everything is a public record from the U.S. government, which anyone may reuse. The one exception is Wikipedia, which is shared
            under a Creative Commons license. We use no paywalled news, no publisher photos and no stock prices.
          </Text>
          <Text style={[styles.small, { color: p.muted }]}>Turn a source off to stop seeing its cards.</Text>
          {sourceError ? <Text style={[styles.small, { color: p.up }]} accessibilityRole="alert">{sourceError}</Text> : null}
          <View>
            {SOURCES.map((s) => {
              const source = SOURCE_KEYS.find((x) => x.key === s.key);
              const hidden = acct.viewPrefs?.hiddenSources ?? [];
              const on = !hidden.includes(s.key);
              return (
              <View key={s.name} style={[styles.source, { borderTopColor: p.border }]}>
                <View style={styles.sourceHeading}>
                  <Text style={[styles.sourceName, { color: on ? p.ink : p.muted }]}>{s.name}</Text>
                  {source ? <Switch
                    value={on}
                    onValueChange={() => {
                      const next = toggleSource(hidden, source.key);
                      if (!next) { setSourceError('Keep at least one source on.'); return; }
                      setSourceError(null);
                      void acct.saveSources(next).catch((e) => setSourceError(userMessage(e)));
                    }}
                    trackColor={{ false: p.borderStrong, true: p.accent }}
                    accessibilityLabel={`${s.name}: ${on ? 'on' : 'off'}`}
                    style={styles.switch}
                  /> : null}
                </View>
                <Text style={[styles.small, { color: p.muted }]}>{s.gives}</Text>
                <View style={styles.links}>
                  <Link label="Website" url={s.site} />
                  <Link label={s.terms.label} url={s.terms.url} />
                </View>
              </View>
            );})}
          </View>
          {notices.map((n) => (
            <Text
              key={n.key}
              style={[styles.small, { color: p.muted }]}
              onPress={n.url ? () => openUrl(n.url as string) : undefined}
              accessibilityRole={n.url ? 'link' : 'text'}
            >
              {n.text}
            </Text>
          ))}
        </Section>

        <Section title="How we collect it">
          <Bullets
            items={[
              'A small program checks the official feeds and data services above several times a day.',
              'It downloads full pages from only three websites: sec.gov, federalreserve.gov and bls.gov. Everything else comes from the source’s own feed or data service.',
              'It tells the SEC who we are on every request, as the SEC requires.',
            ]}
          />
        </Section>

        <Section title="How we filter it">
          <Bullets
            items={[
              'Company filings only for about 150 well-known companies, and only for big events: earnings, CEO or CFO changes, big deals, layoffs, data breaches, restated results and bankruptcies. Routine filings are skipped before any AI is used.',
              'An AI rates how much a typical person would care, from 1 to 5. Anything below 3 is not published.',
              'Duplicates are removed, and no company gets more than 3 cards a day.',
              'Economic numbers become cards only when the change is big enough to matter.',
            ]}
          />
        </Section>

        <Section title="How cards are written">
          <Bullets
            items={[
              'An AI writes each summary from the source text: Google Gemini (free tier), with Groq as a backup. Some cards use a fixed template and no AI at all.',
              'Cards are written in plain words, at about an 8th-grade reading level.',
              'Every AI card is checked automatically: every number must appear in the source, there is no buy, sell or advice language, only short quotes are copied (at most 10 words from filings and Wikipedia, 25 from Fed and BLS text), and the length is limited.',
              'If a draft fails a check it gets one more try. If it still fails, a backup or a plain template card is used instead.',
              `AI cards are marked “${aiNoticeText(config)}”. The “More detail” view is written in the same step and passes the same checks.`,
            ]}
          />
        </Section>

        <Section title="How the feeds are ordered">
          <Bullets
            items={[
              'Trending: the most important cards first, balanced with freshness and how much readers engage with them.',
              'Latest: newest first.',
              'For you (with an account): learns from your favorite and hidden topics, the sources you switch off, the cards you like or dislike, and how long you spend on each card. Only taps and time on cards are stored (likes, cards viewed, sources and details opened, seconds per card), never anything you type.',
            ]}
          />
        </Section>

        <Section title="Your data">
          <Bullets
            items={[
              'Reading never needs an account.',
              'With an account we store your email, the topics and sources you pick, your reactions and taps, and how long you look at each card, only to tailor your feed.',
              'Your password is handled by our sign-in service (Supabase Auth), which keeps only a one-way hash of it. We never see or store the password itself.',
              'On the Account screen you can delete your data or your whole account at any time.',
              'Cloudflare Web Analytics counts page views for the whole site without cookies and without identifying you.',
            ]}
          />
        </Section>

        <Section title="More">
          <QuickLinks account />
        </Section>

        <DeviceData />

        <View style={[styles.tint, wide && styles.tintWide, { backgroundColor: p.accentSoft }]}>
          <Text style={[wide ? styles.textWide : styles.text, { color: p.accentInk }]}>
            <Text style={styles.strong}>{disclaimerText(config)}</Text>
            {'\n'}AI can make mistakes. Always check the source before relying on anything here; every card links to it.
          </Text>
        </View>

        {api.sample ? (
          <Text style={[styles.small, { color: p.dataInk }]}>This build shows fictional sample cards. Their headlines start with [SAMPLE].</Text>
        ) : null}
      </View>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  column: { gap: 20 },
  columnWide: { maxWidth: 820, width: '100%', alignSelf: 'flex-start', gap: 32 },
  lead: { fontFamily: fonts.serif, fontSize: 26, lineHeight: 31, letterSpacing: -0.4 },
  leadWide: { fontSize: 38, lineHeight: 42, letterSpacing: -0.76 },
  section: { gap: 8 },
  text: { fontFamily: fonts.sans, fontSize: font.nav, lineHeight: 23 },
  textWide: { fontFamily: fonts.sans, fontSize: 18, lineHeight: 28 },
  small: { fontFamily: fonts.sans, fontSize: font.meta, lineHeight: 19 },
  strong: { fontFamily: fonts.sansSemi },
  flex: { flex: 1 },
  bullets: { gap: 8 },
  bulletRow: { flexDirection: 'row', gap: 10 },
  bullet: { fontFamily: fonts.sansSemi, fontSize: font.body, lineHeight: 23 },
  source: { borderTopWidth: 1, paddingVertical: 12, gap: 2 },
  sourceHeading: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  switch: { minHeight: 44 },
  sourceName: { fontFamily: fonts.sansSemi, fontSize: font.nav },
  links: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 16, paddingTop: 2 },
  link: { fontFamily: fonts.sansSemi, fontSize: font.meta, textDecorationLine: 'underline', paddingVertical: 10 },
  tint: { paddingVertical: 14, paddingHorizontal: 16, borderRadius: 14 },
  tintWide: { paddingVertical: 18, paddingHorizontal: 22, borderRadius: 16 },
});
