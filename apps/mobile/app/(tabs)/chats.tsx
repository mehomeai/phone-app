import { Feather } from '@expo/vector-icons';
import { router, useNavigation } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
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
  const [draftVersion, setDraftVersion] = useState(0);
  useEffect(() => navigation.addListener('tabPress', () => {
    setConversationId(null);
    setShowHistory(false);
    setDraftVersion((version) => version + 1);
  }), [navigation]);
  const history = useMemo(
    // Identity-scoped in both modes: demo follows the active profile, home
    // follows the authenticated paired user (see visibleChats).
    () => visibleChats.filter((x) => x.messages.length > 0 || x.title.startsWith('Call with ')),
    [visibleChats],
  );

  const startNew = () => {
    tap();
    setConversationId(null);
    setShowHistory(false);
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
            conversations={history}
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

function HistoryList({ conversations, onOpen, onDelete }: { conversations: Conversation[]; onOpen: (id: string) => void; onDelete: (item: Conversation) => void }) {
  const c = useColors();
  const visibleSnippet = (text: string) => text
    .replace(/^\[Scripted demo reply\]\s*/, '')
    .replace(/^\(Fictional demo\)\s*/, '');
  return (
      <FlatList<Conversation>
        testID="chat-history-list"
      style={{ flex: 1 }}
      data={conversations}
      keyExtractor={(item) => item.id}
      scrollEnabled={conversations.length > 0}
      contentContainerStyle={{ padding: 20, paddingBottom: 90, gap: 10, flexGrow: 1 }}
      ListHeaderComponent={<Text style={{ fontFamily: F.mono, fontSize: 10, letterSpacing: 1.2, color: c.mutedForeground, marginBottom: 2 }}>PREVIOUS CONVERSATIONS</Text>}
      ListEmptyComponent={
        <View style={st.empty}>
          <Feather name="clock" size={27} color={c.mutedForeground} />
          <Text style={{ fontFamily: F.medium, fontSize: 17, color: c.foreground, marginTop: 12 }}>Nothing here yet</Text>
              <Text style={{ fontFamily: F.regular, fontSize: 14, color: c.mutedForeground, textAlign: 'center', marginTop: 4 }}>Conversations appear after you send a message or make a call.</Text>
        </View>
      }
      renderItem={({ item }: ListRenderItemInfo<Conversation>) => {
        const last = item.messages[item.messages.length - 1];
        const snippet = last ? visibleSnippet(last.text) : 'Simulated call · no audio';
        return (
          <Card style={{ padding: 0, overflow: 'hidden', flexDirection: 'row', alignItems: 'center' }}>
            <Pressable testID={`conv-${item.id}`} accessibilityRole="button" onPress={() => onOpen(item.id)} style={({ pressed }) => [st.historyRow, { opacity: pressed ? 0.72 : 1 }]}>
              <View style={[st.historyMark, { backgroundColor: c.accentSoft }]}>
                <Feather name={item.title.startsWith('Call with ') ? 'phone' : 'message-circle'} size={16} color={c.accent} />
              </View>
              <View style={{ flex: 1 }}>
                <Text numberOfLines={1} style={{ fontFamily: F.medium, fontSize: 15, color: c.foreground }}>{item.title}</Text>
                <Text numberOfLines={1} style={{ fontFamily: F.regular, fontSize: 13, color: c.mutedForeground, marginTop: 4 }}>{snippet}</Text>
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
  historyRow: { flex: 1, minHeight: 72, flexDirection: 'row', alignItems: 'center', gap: 11, paddingLeft: 12, paddingRight: 6 },
  historyMark: { width: 34, height: 34, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
});
