import { Feather } from '@expo/vector-icons';
import { router, useNavigation } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { ListRenderItemInfo } from 'react-native';
import { ChatComposer } from '@/components/ChatComposer';
import { Card, F, Hydrated, ScreenHeader, StatusDot, tap } from '@/components/ui';
import { useMe } from '@/context/MeContext';
import { useColors } from '@/hooks/useColors';
import type { Conversation } from '@/lib/types';

export default function ChatsScreen() {
  return (
    <Hydrated>
      <Chats />
    </Hydrated>
  );
}

function confirm(title: string, msg: string, onYes: () => void) {
  if (Platform.OS === 'web') {
    if (window.confirm(`${title}\n\n${msg}`)) onYes();
    return;
  }
  Alert.alert(title, msg, [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: onYes }]);
}

function visibleMessageText(text: string) {
  return text
    .replace(/^\[Scripted demo reply\]\s*/, '')
    .replace(/^\(Fictional demo\)\s*/, '');
}

type HistoryDateFilter = 'all' | 'today' | '7days' | '30days';

function conversationActivityAt(conversation: Conversation) {
  const latestMessage = conversation.messages.reduce((latest, message) => Math.max(latest, message.createdAt), 0);
  return latestMessage || conversation.createdAt || 0;
}

function matchesHistoryDate(conversation: Conversation, filter: HistoryDateFilter, now = Date.now()) {
  if (filter === 'all') return true;
  const timestamp = conversationActivityAt(conversation);
  if (!timestamp) return false;
  if (filter === 'today') {
    const current = new Date(now);
    const startOfDay = new Date(current.getFullYear(), current.getMonth(), current.getDate()).getTime();
    return timestamp >= startOfDay && timestamp <= now;
  }
  const days = filter === '7days' ? 7 : 30;
  return timestamp >= now - days * 24 * 60 * 60 * 1000 && timestamp <= now;
}

function Chats() {
  const c = useColors();
  const navigation = useNavigation() as unknown as { addListener: (event: 'tabPress', listener: () => void) => () => void };
  const {
    visibleChats,
    activeProfile,
    createConversation,
    deleteConversation,
    settings,
    connectionStatus,
    activeCallId,
    beginCall,
  } = useMe();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [historyQuery, setHistoryQuery] = useState('');
  const [historyDateFilter, setHistoryDateFilter] = useState<HistoryDateFilter>('all');
  const [draftVersion, setDraftVersion] = useState(0);
  useEffect(() => navigation.addListener('tabPress', () => {
    setConversationId(null);
    setShowHistory(false);
    setHistoryQuery('');
    setHistoryDateFilter('all');
    setDraftVersion((version) => version + 1);
  }), [navigation]);
  const history = useMemo(
    // Identity-scoped in both modes: demo follows the active profile, home
    // follows the authenticated paired user (see visibleChats).
    () => visibleChats.filter((x) => x.messages.length > 0 || x.title.startsWith('Call with ')),
    [visibleChats],
  );
  const normalizedQuery = historyQuery.trim().toLowerCase();
  const filteredHistory = useMemo(
    () => history.filter((conversation) =>
      matchesHistoryDate(conversation, historyDateFilter) &&
      (!normalizedQuery ||
        conversation.title.toLowerCase().includes(normalizedQuery) ||
        conversation.messages.some((message) => visibleMessageText(message.text).toLowerCase().includes(normalizedQuery))),
    ),
    [history, historyDateFilter, normalizedQuery],
  );

  const startNew = () => {
    tap();
    setConversationId(null);
    setShowHistory(false);
    setHistoryQuery('');
    setHistoryDateFilter('all');
    setDraftVersion((version) => version + 1);
  };
  const startCall = () => {
    if (activeCallId !== null) return;
    const createdForCall = !conversationId;
    const targetId = conversationId ?? createConversation(`Call with ${activeProfile.name.split(' ')[0]}`);
    if (!beginCall(targetId)) {
      if (createdForCall) deleteConversation(targetId);
      return;
    }
    if (createdForCall) setConversationId(targetId);
    tap();
    router.push({ pathname: '/call/[id]', params: { id: targetId } });
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScreenHeader
        eyebrow={`${activeProfile.name.split(' ')[0]}'s private space`}
        title="Chat"
        right={
          <View style={st.headerActions}>
            <Pressable
              testID="new-chat"
              accessibilityRole="button"
              accessibilityLabel="New chat"
              onPress={startNew}
              hitSlop={9}
              style={({ pressed }) => [st.iconButton, { backgroundColor: c.card, borderColor: c.border, opacity: pressed ? 0.65 : 1 }]}
            >
              <Feather name="edit-3" size={17} color={c.foreground} />
            </Pressable>
            <Pressable
              testID="chat-history"
              accessibilityRole="button"
              accessibilityLabel="Show conversation history"
              accessibilityState={{ selected: showHistory }}
              onPress={() => { tap(); setShowHistory(true); }}
              hitSlop={9}
              style={({ pressed }) => [st.iconButton, { backgroundColor: showHistory ? c.accentSoft : c.card, borderColor: showHistory ? c.accent : c.border, opacity: pressed ? 0.65 : 1 }]}
            >
              <Feather name="clock" size={18} color={showHistory ? c.accent : c.foreground} />
            </Pressable>
            <Pressable
              testID="open-chat-browser"
              accessibilityRole="button"
              accessibilityLabel="Open browser"
              onPress={() => { tap(); router.push('/browser'); }}
              hitSlop={9}
              style={({ pressed }) => [st.iconButton, { backgroundColor: c.card, borderColor: c.border, opacity: pressed ? 0.65 : 1 }]}
            >
              <Feather name="globe" size={18} color={c.foreground} />
            </Pressable>
            <Pressable
              testID="start-mock-call"
              accessibilityRole="button"
              accessibilityLabel="Start simulated call"
              disabled={activeCallId !== null}
              onPress={startCall}
              hitSlop={9}
              style={({ pressed }) => [st.iconButton, { backgroundColor: c.card, borderColor: c.border, opacity: activeCallId !== null ? 0.4 : pressed ? 0.65 : 1 }]}
            >
              <Feather name="phone" size={18} color={c.foreground} />
            </Pressable>
          </View>
        }
      />
      {settings.assistantMode !== 'demo' ? (
        <View style={[st.banner, { backgroundColor: connectionStatus === 'connected' ? c.accentSoft : c.muted }]}>
          <StatusDot on={connectionStatus === 'connected'} />
          <Text style={{ fontFamily: F.regular, fontSize: 12, lineHeight: 17, color: c.foreground, flex: 1 }}>
            {connectionStatus === 'connected'
              ? 'Connected directly to Me Home over HTTPS. There is no cloud-model fallback.'
              : connectionStatus === 'connecting'
                ? 'Checking Me Home. Sending is paused until the connection is verified.'
                : connectionStatus === 'offline'
                  ? 'Me Home is offline. Messages queue on this device and send on reconnect; nothing runs until the home accepts it.'
                  : connectionStatus === 'error'
                    ? 'Me Home connection error. Open Me → Me Home to reconnect; messages are not sent to a cloud model.'
                    : 'Me Home is disconnected. Past chats are available; sending is paused.'}
          </Text>
        </View>
      ) : null}

      <View style={{ flex: 1 }}>
        {showHistory ? (
          <HistoryList
            conversations={filteredHistory}
            searchQuery={historyQuery}
            dateFilter={historyDateFilter}
            onSearchQueryChange={setHistoryQuery}
            onDateFilterChange={setHistoryDateFilter}
            onOpen={(id) => { setConversationId(id); setShowHistory(false); }}
            onDelete={(item) => confirm('Delete conversation?', 'It will be removed from this device.', () => deleteConversation(item.id))}
          />
        ) : (
          <ChatComposer
            key={`${conversationId ?? 'new-draft'}-${draftVersion}`}
            conversationId={conversationId}
            onConversationId={setConversationId}
            inTab
          />
        )}
      </View>
    </View>
  );
}

function HistoryList({
  conversations,
  searchQuery,
  dateFilter,
  onSearchQueryChange,
  onDateFilterChange,
  onOpen,
  onDelete,
}: {
  conversations: Conversation[];
  searchQuery: string;
  dateFilter: HistoryDateFilter;
  onSearchQueryChange: (value: string) => void;
  onDateFilterChange: (value: HistoryDateFilter) => void;
  onOpen: (id: string) => void;
  onDelete: (item: Conversation) => void;
}) {
  const c = useColors();
  const dateFilters: { id: HistoryDateFilter; label: string }[] = [
    { id: 'all', label: 'All dates' },
    { id: 'today', label: 'Today' },
    { id: '7days', label: '7 days' },
    { id: '30days', label: '30 days' },
  ];
  return (
      <FlatList<Conversation>
        testID="chat-history-list"
      style={{ flex: 1 }}
      data={conversations}
      keyExtractor={(item) => item.id}
      scrollEnabled={conversations.length > 0}
      contentContainerStyle={{ padding: 20, paddingBottom: 90, gap: 10, flexGrow: 1 }}
      ListHeaderComponent={
        <View style={{ gap: 12, marginBottom: 3 }}>
          <Text style={{ fontFamily: F.mono, fontSize: 10, letterSpacing: 1.2, color: c.mutedForeground }}>PREVIOUS CONVERSATIONS</Text>
          <View style={[st.searchBar, { backgroundColor: c.card, borderColor: c.border }]}>
            <Feather name="search" size={17} color={c.mutedForeground} />
            <TextInput
              testID="chat-history-search"
              accessibilityLabel="Search conversation titles and messages"
              value={searchQuery}
              onChangeText={onSearchQueryChange}
              placeholder="Search titles and messages"
              placeholderTextColor={c.mutedForeground}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              style={[st.searchInput, { color: c.foreground }]}
            />
            {searchQuery.length > 0 ? (
              <Pressable
                testID="chat-history-search-clear"
                accessibilityRole="button"
                accessibilityLabel="Clear chat history search"
                hitSlop={8}
                onPress={() => onSearchQueryChange('')}
                style={st.searchClear}
              >
                <Feather name="x" size={16} color={c.mutedForeground} />
              </Pressable>
            ) : null}
          </View>
          <View accessibilityRole="radiogroup" accessibilityLabel="Filter conversations by date" style={st.dateFilters}>
            {dateFilters.map((filter) => (
              <Pressable
                key={filter.id}
                testID={`chat-history-date-${filter.id}`}
                accessibilityRole="radio"
                accessibilityLabel={filter.label}
                accessibilityState={{ checked: dateFilter === filter.id }}
                onPress={() => onDateFilterChange(filter.id)}
                style={[
                  st.dateFilter,
                  {
                    backgroundColor: dateFilter === filter.id ? c.accentSoft : c.card,
                    borderColor: dateFilter === filter.id ? c.accent : c.border,
                  },
                ]}
              >
                <Text style={{ fontFamily: F.medium, fontSize: 12, color: dateFilter === filter.id ? c.accent : c.mutedForeground }}>
                  {filter.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      }
      ListEmptyComponent={
        <View style={st.empty}>
          <Feather name={searchQuery.trim() ? 'search' : 'clock'} size={27} color={c.mutedForeground} />
          <Text style={{ fontFamily: F.medium, fontSize: 17, color: c.foreground, marginTop: 12 }}>
            {searchQuery.trim() ? 'No matches' : dateFilter !== 'all' ? 'No conversations in this period' : 'Nothing here yet'}
          </Text>
          <Text style={{ fontFamily: F.regular, fontSize: 14, color: c.mutedForeground, textAlign: 'center', marginTop: 4 }}>
            {searchQuery.trim()
              ? 'Try another title or message, or broaden the date range.'
              : dateFilter !== 'all'
                ? 'Choose a wider date range to see older conversations.'
                : 'Conversations appear after you send a message or make a call.'}
          </Text>
        </View>
      }
      renderItem={({ item }: ListRenderItemInfo<Conversation>) => {
        const normalizedSearch = searchQuery.trim().toLowerCase();
        const matchingMessage = normalizedSearch
          ? item.messages.find((message) => visibleMessageText(message.text).toLowerCase().includes(normalizedSearch))
          : undefined;
        const last = matchingMessage ?? item.messages[item.messages.length - 1];
        const snippet = last ? visibleMessageText(last.text) : 'Simulated call · no audio';
        // Ported from the Replit copy's Nov 3 fix: a new conversation's
        // title is its first message (truncated to 42 chars), so when the
        // latest message is still that first one, the preview line would
        // repeat the title inside the same row. Show it only when it adds
        // different text.
        const showSnippet = snippet !== item.title && !(item.messages.length === 1 && snippet.startsWith(item.title));
        return (
          <Card style={{ padding: 0, overflow: 'hidden', flexDirection: 'row', alignItems: 'center' }}>
            <Pressable testID={`conv-${item.id}`} accessibilityRole="button" onPress={() => onOpen(item.id)} style={({ pressed }) => [st.historyRow, { opacity: pressed ? 0.72 : 1 }]}>
              <View style={[st.historyMark, { backgroundColor: c.accentSoft }]}>
                <Feather name={item.title.startsWith('Call with ') ? 'phone' : 'message-circle'} size={16} color={c.accent} />
              </View>
              <View style={{ flex: 1 }}>
                <Text numberOfLines={1} style={{ fontFamily: F.medium, fontSize: 15, color: c.foreground }}>{item.title}</Text>
                {showSnippet ? (
                  <Text numberOfLines={1} style={{ fontFamily: F.regular, fontSize: 13, color: c.mutedForeground, marginTop: 4 }}>{snippet}</Text>
                ) : null}
              </View>
              <Feather name="chevron-right" size={17} color={c.mutedForeground} />
            </Pressable>
            <Pressable
              testID={`delete-${item.id}`}
              accessibilityRole="button"
              accessibilityLabel={`Delete ${item.title}`}
              onPress={() => onDelete(item)}
              hitSlop={8}
              style={{ padding: 12 }}
            >
              <Feather name="trash-2" size={16} color={c.mutedForeground} />
            </Pressable>
          </Card>
        );
      }}
    />
  );
}

const st = StyleSheet.create({
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  iconButton: { width: 38, height: 38, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  banner: { marginHorizontal: 20, padding: 10, borderRadius: 10, flexDirection: 'row', alignItems: 'center', gap: 8 },
  empty: { flex: 1, minHeight: 240, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 },
  searchBar: { minHeight: 46, borderWidth: 1, borderRadius: 13, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 9 },
  searchInput: { flex: 1, minWidth: 0, paddingVertical: 10, fontFamily: F.regular, fontSize: 14 },
  searchClear: { width: 28, height: 32, alignItems: 'center', justifyContent: 'center' },
  dateFilters: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  dateFilter: { minHeight: 34, justifyContent: 'center', borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  historyRow: { flex: 1, minHeight: 72, flexDirection: 'row', alignItems: 'center', gap: 11, paddingLeft: 12, paddingRight: 6 },
  historyMark: { width: 34, height: 34, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
});
