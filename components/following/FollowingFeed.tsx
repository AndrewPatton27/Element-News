import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { AppConfig, BlurbCard, Category } from '../../contract/types.ts';
import type { FeedState } from '../../lib/feed/feedLogic';
import { usePalette, useWide } from '../../lib/theme/useTheme';
import { fonts } from '../../lib/theme/theme';
import { SearchResultCard } from '../search/SearchResultCard';
import { ListSkeleton } from '../shell/States';

// The Following feed: the same tiles as Search (headline, takeaways, "Because you follow"
// line, one-line bottom bar), two columns on wide web. The AI notice and the disclaimer
// are the screen's persistent strip (D-80).
export function FollowingFeed({ items, state, config, categories, reasonFor, onOpen, onSources, onMore, onRetry, empty }: {
  items: BlurbCard[]; state: Pick<FeedState, 'loading'|'done'|'error'>; config: AppConfig|null; categories: Category[];
  reasonFor: (c: BlurbCard) => string|null;
  onOpen: (c: BlurbCard) => void; onSources: (c: BlurbCard) => void; onMore: () => void; onRetry: () => void; empty?: ReactNode;
}) {
  const p=usePalette(), wide=useWide();
  if (!items.length && state.error) return <View style={s.state} accessibilityRole="alert"><Text style={[s.head,{color:p.ink}]}>Could not load stories</Text><Text style={{color:p.muted}}>{state.error}</Text><Pressable onPress={onRetry} style={[s.action,{backgroundColor:p.accent}]}><Text style={{color:p.onAccent}}>Try again</Text></Pressable></View>;
  if (!items.length && (state.loading || !state.done)) return <ListSkeleton label="Loading stories…" />;
  if (!items.length) return <>{empty}</>;
  return <View style={{gap:14}}><View style={[s.grid,wide&&s.gridWide]}>{items.map(c=>{
    const related = c.story_link?.related_headline ? `${c.story_link.kind==='update'?'Update to:':'Related to:'} ${c.story_link.related_headline}` : null;
    return <View key={c.id} style={wide?s.cardWide:s.cardNarrow}>
      <SearchResultCard card={c} config={config} categories={categories} reason={reasonFor(c)} related={related} onOpen={onOpen} onShowSources={onSources}/>
    </View>;
  })}</View>{state.error?<Pressable onPress={onRetry} style={s.state}><Text style={{color:p.warn}}>Could not load more. Tap to retry.</Text></Pressable>:state.loading?<ActivityIndicator color={p.accent}/>:!state.done?<Pressable onPress={onMore} accessibilityRole="button" style={[s.action,{borderColor:p.borderStrong,backgroundColor:p.surface}]}><Text style={{color:p.ink}}>Show more</Text></Pressable>:null}</View>;
}
const s=StyleSheet.create({grid:{gap:14},gridWide:{flexDirection:'row',flexWrap:'wrap',justifyContent:'space-between',rowGap:16},cardNarrow:{width:'100%'},cardWide:{width:'48.5%'},state:{minHeight:80,alignItems:'center',justifyContent:'center',gap:10},head:{fontFamily:fonts.serif,fontSize:22},action:{minHeight:44,paddingHorizontal:20,borderRadius:22,borderWidth:1,alignSelf:'center',justifyContent:'center'}});
