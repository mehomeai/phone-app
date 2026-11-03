import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Card, F, tap } from '@/components/ui';
import { useColors } from '@/hooks/useColors';

const categories = ['All', 'Email', 'Calendar', 'Files', 'Work', 'Personal', 'Media'] as const;
type Category = (typeof categories)[number];

const connectors = [
  { id: 'gmail', name: 'Gmail', category: 'Email', icon: 'mail', detail: 'Email and drafts' },
  { id: 'outlook', name: 'Outlook', category: 'Email', icon: 'inbox', detail: 'Email and drafts' },
  { id: 'google-calendar', name: 'Google Calendar', category: 'Calendar', icon: 'calendar', detail: 'Events and availability' },
  { id: 'apple-calendar', name: 'Apple Calendar', category: 'Calendar', icon: 'calendar', detail: 'Events and reminders' },
  { id: 'microsoft-calendar', name: 'Microsoft Calendar', category: 'Calendar', icon: 'calendar', detail: 'Events and availability' },
  { id: 'google-drive', name: 'Google Drive', category: 'Files', icon: 'hard-drive', detail: 'Files and documents' },
  { id: 'google-docs', name: 'Google Docs', category: 'Files', icon: 'file-text', detail: 'Documents' },
  { id: 'google-sheets', name: 'Google Sheets', category: 'Files', icon: 'grid', detail: 'Spreadsheets' },
  { id: 'google-photos', name: 'Google Photos', category: 'Files', icon: 'image', detail: 'Photos and albums' },
  { id: 'onedrive', name: 'OneDrive', category: 'Files', icon: 'cloud', detail: 'Files and documents' },
  { id: 'dropbox', name: 'Dropbox', category: 'Files', icon: 'box', detail: 'Files and folders' },
  { id: 'slack', name: 'Slack', category: 'Work', icon: 'message-square', detail: 'Messages and channels' },
  { id: 'teams', name: 'Microsoft Teams', category: 'Work', icon: 'users', detail: 'Chats and meetings' },
  { id: 'notion', name: 'Notion', category: 'Work', icon: 'file-text', detail: 'Pages and notes' },
  { id: 'github', name: 'GitHub', category: 'Work', icon: 'code', detail: 'Repositories and issues' },
  { id: 'linear', name: 'Linear', category: 'Work', icon: 'layers', detail: 'Projects and issues' },
  { id: 'todoist', name: 'Todoist', category: 'Personal', icon: 'check-square', detail: 'Tasks and reminders' },
  { id: 'contacts', name: 'Contacts', category: 'Personal', icon: 'users', detail: 'People and details' },
  { id: 'spotify', name: 'Spotify', category: 'Media', icon: 'music', detail: 'Music and playlists' },
  { id: 'youtube', name: 'YouTube', category: 'Media', icon: 'play-circle', detail: 'Videos and channels' },
] as const;

type ConnectorId = (typeof connectors)[number]['id'];
type Connector = (typeof connectors)[number];

export function AppsPanel({ addedIds, onToggle }: { addedIds: string[]; onToggle: (id: ConnectorId) => void }) {
  const c = useColors();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<Category>('All');
  const filtered = useMemo(() => connectors.filter((item) => {
    const matchesCategory = category === 'All' || item.category === category;
    const matchesSearch = `${item.name} ${item.category} ${item.detail}`.toLowerCase().includes(query.trim().toLowerCase());
    return matchesCategory && matchesSearch;
  }), [category, query]);

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding" keyboardVerticalOffset={0}>
      <ScrollView
        style={{ flex: 1, backgroundColor: c.background }}
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 36 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={st.intro}>
          <Text style={{ fontFamily: F.medium, fontSize: 23, letterSpacing: -0.6, color: c.foreground }}>Apps and services</Text>
          <Text style={{ fontFamily: F.regular, fontSize: 14, lineHeight: 20, color: c.mutedForeground, marginTop: 5 }}>
            Choose what Me could work with. These controls are previews; no account data is accessed.
          </Text>
        </View>

        <Pressable
          testID="open-browser"
          accessibilityRole="button"
          accessibilityLabel="Open browser"
          onPress={() => { tap(); router.push('/browser'); }}
          style={({ pressed }) => [st.browserCard, { backgroundColor: c.primary, opacity: pressed ? 0.82 : 1 }]}
        >
          <View style={[st.browserIcon, { backgroundColor: c.accent }]}>
            <Feather name="globe" size={20} color={c.accentForeground} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontFamily: F.medium, fontSize: 16, color: c.primaryForeground }}>Web browser</Text>
            <Text style={{ fontFamily: F.regular, fontSize: 13, lineHeight: 18, color: c.primaryForeground, opacity: 0.74, marginTop: 3 }}>
              Open websites in a browser window.
            </Text>
          </View>
          <Feather name="arrow-up-right" size={19} color={c.primaryForeground} />
        </Pressable>

        <View style={[st.search, { backgroundColor: c.card, borderColor: c.border }]}>
          <Feather name="search" size={17} color={c.mutedForeground} />
          <TextInput
            testID="connector-search"
            accessibilityLabel="Search apps and services"
            value={query}
            onChangeText={setQuery}
            placeholder="Search apps"
            placeholderTextColor={c.mutedForeground}
            autoCapitalize="none"
            autoCorrect={false}
            style={{ flex: 1, color: c.foreground, fontFamily: F.regular, fontSize: 14, paddingVertical: 0 }}
          />
          {query ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => setQuery('')}>
              <Feather name="x-circle" size={17} color={c.mutedForeground} />
            </Pressable>
          ) : null}
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={st.filters}>
          {categories.map((item) => {
            const selected = category === item;
            return (
              <Pressable
                key={item}
                testID={`connector-filter-${item.toLowerCase()}`}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                onPress={() => { tap(); setCategory(item); }}
                style={[st.filter, { backgroundColor: selected ? c.accentSoft : c.card, borderColor: selected ? c.accent : c.border }]}
              >
                <Text style={{ fontFamily: F.medium, fontSize: 12, color: selected ? c.accent : c.foreground }}>{item}</Text>
              </Pressable>
            );
          })}
        </ScrollView>

        <View style={st.listHeading}>
          <Text style={{ fontFamily: F.medium, fontSize: 16, color: c.foreground }}>
            {category === 'All' ? 'Popular apps' : category}
          </Text>
          <Text style={{ fontFamily: F.regular, fontSize: 12, color: c.mutedForeground }}>{filtered.length}</Text>
        </View>

        {filtered.length ? (
          <View style={st.grid}>
            {filtered.map((item) => (
              <ConnectorCard
                key={item.id}
                item={item}
                added={addedIds.includes(item.id)}
                onPress={() => onToggle(item.id)}
              />
            ))}
          </View>
        ) : (
          <Card style={{ alignItems: 'center', marginTop: 4 }}>
            <Feather name="search" size={22} color={c.mutedForeground} />
            <Text style={{ fontFamily: F.medium, fontSize: 15, color: c.foreground, marginTop: 9 }}>No matching apps</Text>
            <Text style={{ fontFamily: F.regular, fontSize: 13, color: c.mutedForeground, marginTop: 3 }}>Try another name or category.</Text>
          </Card>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function ConnectorCard({ item, added, onPress }: { item: Connector; added: boolean; onPress: () => void }) {
  const c = useColors();
  return (
    <Card style={st.connectorCard}>
      <View style={[st.connectorIcon, { backgroundColor: c.accentSoft }]}>
        <Feather name={item.icon} size={19} color={c.accent} />
      </View>
      <Text numberOfLines={1} style={{ fontFamily: F.medium, fontSize: 14, color: c.foreground, marginTop: 11 }}>{item.name}</Text>
      <Text numberOfLines={1} style={{ fontFamily: F.regular, fontSize: 12, color: c.mutedForeground, marginTop: 3 }}>{item.detail}</Text>
      <Pressable
        testID={`connector-toggle-${item.id}`}
        accessibilityRole="button"
        accessibilityLabel={`${added ? 'Remove' : 'Add'} ${item.name} ${added ? 'from' : 'to'} preview`}
        accessibilityState={{ selected: added }}
        onPress={() => { tap(); onPress(); }}
        style={({ pressed }) => [
          st.addButton,
          { borderColor: added ? c.accent : c.border, backgroundColor: added ? c.accentSoft : c.card, opacity: pressed ? 0.72 : 1 },
        ]}
      >
        <Feather name={added ? 'check' : 'plus'} size={14} color={added ? c.accent : c.foreground} />
        <Text style={{ fontFamily: F.medium, fontSize: 12, color: added ? c.accent : c.foreground }}>{added ? 'Added' : 'Add'}</Text>
      </Pressable>
    </Card>
  );
}

const st = StyleSheet.create({
  intro: { marginBottom: 16 },
  browserCard: { borderRadius: 16, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 12 },
  browserIcon: { width: 42, height: 42, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  search: { minHeight: 46, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, marginTop: 16, flexDirection: 'row', alignItems: 'center', gap: 10 },
  filters: { gap: 8, paddingVertical: 14 },
  filter: { minHeight: 32, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  listHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 10 },
  connectorCard: { width: '48%', minHeight: 150, padding: 12 },
  connectorIcon: { width: 34, height: 34, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  addButton: { minHeight: 32, borderWidth: 1, borderRadius: 9, paddingHorizontal: 10, marginTop: 'auto', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 },
});
