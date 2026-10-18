import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { AppConfig, BlurbCard, Category } from '../contract/types.ts';
import type { FeedState } from '../lib/feedLogic';
import { cardTime, categoryName, clampHeadline } from '../lib/format';
import { cardLabels } from '../lib/labels';
import { usePalette, useWide } from '../lib/useTheme';
import { fonts } from '../lib/theme';
import { badgeLabel } from './Card';
import { SourceRow } from './SourceChip';
import { CardActionRow } from './CardActionRow';

export function FollowingFeed({ items, state, config, categories, reasonFor, onOpen, onSources, onMore, onRetry, empty }: {
  items: BlurbCard[]; state: Pick<FeedState, 'loading'|'done'|'error'>; config: AppConfig|null; categories: Category[];
  reasonFor: (c: BlurbCard) => string|null;
  onOpen: (c: BlurbCard) => void; onSources: (c: BlurbCard) => void; onMore: () => void; onRetry: () => void; empty?: ReactNode;
}) {
  const p=usePalette(), wide=useWide();
  if (!items.length && state.error) return <View style={s.state} accessibilityRole="alert"><Text style={[s.head,{color:p.ink}]}>Could not load stories</Text><Text style={{color:p.muted}}>{state.error}</Text><Pressable onPress={onRetry} style={[s.action,{backgroundColor:p.accent}]}><Text style={{color:p.onAccent}}>Try again</Text></Pressable></View>;
  if (!items.length && (state.loading || !state.done)) return <View style={s.state} accessibilityLiveRegion="polite"><ActivityIndicator color={p.accent}/><Text style={{color:p.muted}}>Loading storiesÃ¢â‚¬Â¦</Text></View>;
  if (!items.length) return <>{empty}</>;
  return <View style={{gap:14}}><View style={[s.grid,wide&&s.gridWide]}>{items.map(c=>{
    const labels=cardLabels(c,config), reason=reasonFor(c);
    return <View key={c.id} style={[s.card,wide?s.wide:s.narrow,wide?s.cardWide:s.cardNarrow,{backgroundColor:p.surface,borderColor:p.border}]}>
      <View style={s.top}><Text style={[s.badge,{color:p.accentInk}]}>Ã¢â€”Â {badgeLabel(c)}</Text><Text style={[s.meta,{color:p.muted}]}>{categoryName(c.category,categories)} Ã‚Â· {cardTime(c)}</Text></View>
      <Pressable onPress={()=>onOpen(c)} accessibilityRole="button" accessibilityLabel={`Open details: ${c.headline}`}><Text style={[s.title,wide&&s.titleWide,{color:p.ink}]}>{clampHeadline(c.headline)}</Text></Pressable>
      {c.story_link?.related_headline ? <Text style={[s.related,{color:p.muted}]}>{c.story_link.kind==='update'?'Update to:':'Related to:'} {c.story_link.related_headline}</Text>:null}
      {c.body?<Text style={[s.body,{color:p.inkBody}]} numberOfLines={4}>{c.body}</Text>:null}
      {reason?<Text style={[s.reason,{color:p.muted}]}>{reason}</Text>:null}
      <SourceRow card={c} onShowAll={()=>onSources(c)} wide={wide}/>
      <View style={[s.foot,{borderTopColor:p.divider}]}><Pressable onPress={()=>onOpen(c)} accessibilityRole="button" style={s.open}><Text style={{color:p.accent,fontFamily:fonts.sansSemi}}>More detail Ã¢â‚¬Âº</Text></Pressable><CardActionRow card={c}/></View>
      <Text style={[s.labels,{color:p.muted}]}>{[labels.aiLabel,labels.disclaimer].filter(Boolean).join(' Ã‚Â· ')}</Text>
    </View>;
  })}</View>{state.error?<Pressable onPress={onRetry} style={s.state}><Text style={{color:p.warn}}>Could not load more. Tap to retry.</Text></Pressable>:state.loading?<ActivityIndicator color={p.accent}/>:!state.done?<Pressable onPress={onMore} accessibilityRole="button" style={[s.action,{borderColor:p.borderStrong,backgroundColor:p.surface}]}><Text style={{color:p.ink}}>Show more</Text></Pressable>:null}</View>;
}
const s=StyleSheet.create({grid:{gap:14},gridWide:{flexDirection:'row',flexWrap:'wrap',justifyContent:'space-between'},card:{borderWidth:1,borderRadius:20,gap:10},cardNarrow:{width:'100%'},cardWide:{width:'48%'},narrow:{paddingVertical:16,paddingHorizontal:18},wide:{paddingVertical:22,paddingHorizontal:24},top:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',gap:8},badge:{fontSize:12,fontFamily:fonts.sansSemi},meta:{fontSize:12,flexShrink:1,textAlign:'right'},title:{fontFamily:fonts.serif,fontSize:21,lineHeight:25},titleWide:{fontSize:26,lineHeight:30},related:{fontFamily:fonts.sans,fontSize:13,lineHeight:18},body:{fontFamily:fonts.sans,fontSize:15,lineHeight:22},reason:{fontFamily:fonts.sans,fontSize:13,lineHeight:19},foot:{borderTopWidth:1,flexDirection:'row',alignItems:'center',justifyContent:'space-between',marginHorizontal:-8,paddingTop:2},open:{minHeight:44,justifyContent:'center',paddingHorizontal:8},labels:{fontSize:12,lineHeight:17},state:{minHeight:80,alignItems:'center',justifyContent:'center',gap:10},head:{fontFamily:fonts.serif,fontSize:22},action:{minHeight:44,paddingHorizontal:20,borderRadius:22,borderWidth:1,alignSelf:'center',justifyContent:'center'}});
