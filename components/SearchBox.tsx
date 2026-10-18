// The search field (design Mobile-Search / Web-Search): a rounded pill with a
// magnifier, the text, and a clear button once there is text. Enter submits.

import { useRef, type ComponentRef } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { SEARCH_MAX_CHARS } from '../lib/searchLogic';
import { usePalette } from '../lib/useTheme';
import { fonts, font } from '../lib/theme';
import { CloseIcon, SearchIcon } from './Icons';

export interface SearchBoxProps {
  value: string;
  onChangeText: (text: string) => void;
  onSubmit: () => void;
  onClear: () => void;
  wide?: boolean;
  placeholder?: string;
}

export function SearchBox({ value, onChangeText, onSubmit, onClear, wide, placeholder = 'Search stories, companies, topics' }: SearchBoxProps) {
  const p = usePalette();
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  return (
    <View
      style={[
        styles.box,
        wide ? styles.boxWide : styles.boxNarrow,
        { backgroundColor: wide ? p.surface : p.surfaceMuted, borderColor: p.borderStrong },
      ]}
    >
      <SearchIcon color={p.muted} size={wide ? 22 : 20} strokeWidth={1.8} />
      <TextInput
        ref={input}
        value={value}
        onChangeText={onChangeText}
        onSubmitEditing={onSubmit}
        placeholder={placeholder}
        placeholderTextColor={p.muted}
        accessibilityLabel="Search stories, companies and topics"
        returnKeyType="search"
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={SEARCH_MAX_CHARS}
        // Web: the pill itself is the visible field; keep the browser's default ring off the inner input.
        style={[styles.input, { color: p.ink, fontSize: wide ? 18 : font.body }, { outlineStyle: 'none' } as object]}
      />
      {value.length > 0 ? (
        <Pressable
          onPress={() => {
            onClear();
            input.current?.focus();
          }}
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          hitSlop={8}
          style={styles.clear}
        >
          <CloseIcon color={p.muted} size={18} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { flexDirection: 'row', alignItems: 'center', borderWidth: 1 },
  boxNarrow: { height: 44, paddingHorizontal: 14, borderRadius: 22, gap: 10 },
  boxWide: { height: 56, paddingHorizontal: 20, borderRadius: 28, gap: 12 },
  input: { flex: 1, minWidth: 0, fontFamily: fonts.sans, paddingVertical: 0 },
  clear: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
});
