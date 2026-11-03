import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { FlatList, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { ListRenderItemInfo } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { isLiquidGlassAvailable } from 'expo-glass-effect';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { F, MeMark, tap, useTopInset } from '@/components/ui';
import { TaskPanel } from '@/components/TaskPanel';
import { useMe } from '@/context/MeContext';
import { useColors } from '@/hooks/useColors';
import type { Message } from '@/lib/types';

interface Props {
  conversationId: string | null;
  onConversationId?: (id: string) => void;
  showBack?: boolean;
  inTab?: boolean;
}

export function ChatComposer({ conversationId, onConversationId, showBack = false, inTab = false }: Props) {
  const c = useColors();
  const top = useTopInset();
  const insets = useSafeAreaInsets();
  const {
    conversations,
    visibleChats,
    sendMessage,
    retryMessage,
    openConversation,
    typing,
    chatErrors,
    connectionStatus,
    settings,
    activeCallId,
    beginCall,
    createConversation,
    deleteConversation,
    activeProfile,
  } = useMe();
  const [text, setText] = useState('');
  const inputRef = useRef<React.ComponentRef<typeof TextInput>>(null);
  const currentId = useRef<string | null>(conversationId);
  const id = conversationId ?? currentId.current;
  // Scoped lookup: a deep link or stale id outside the current identity
  // resolves to nothing instead of leaking cached private content.
  const conv = (settings.assistantMode === 'home' ? visibleChats : conversations).find((x) => x.id === id);
  const scopedOut = settings.assistantMode === 'home' && !!id && !conv;
  const messages = conv?.messages ?? [];
  const isTyping = !!(id && typing[id]);
  const chatError = id ? chatErrors[id] : undefined;
  const canSend = settings.assistantMode === 'demo' || connectionStatus === 'connected' || connectionStatus === 'offline';
  const title = conv?.title ?? 'Me';

  useEffect(() => {
    currentId.current = conversationId;
  }, [conversationId]);

  // Pull home-authoritative history (and tasks) when a conversation opens.
  useEffect(() => {
    if (conversationId) openConversation(conversationId);
  }, [conversationId, openConversation]);

  const startCall = () => {
    if (activeCallId !== null) return;
    const createdForCall = !id;
    const targetId = id ?? createConversation(`Call with ${activeProfile.name.split(' ')[0]}`);
    if (!beginCall(targetId)) {
      if (createdForCall) deleteConversation(targetId);
      return;
    }
    if (createdForCall) {
      currentId.current = targetId;
      onConversationId?.(targetId);
    }
    tap();
    router.push({ pathname: '/call/[id]', params: { id: targetId } });
  };

  const send = () => {
    const clean = text.trim();
    if (!canSend || isTyping || !clean) return;
    tap();
    const nextId = sendMessage(id, clean);
    currentId.current = nextId;
    onConversationId?.(nextId);
    setText('');
    inputRef.current?.focus();
  };

  const back = () => (router.canGoBack() ? router.back() : router.replace('/chats'));
  const data = [...messages].reverse();
  const tabBarOffset = inTab && !isLiquidGlassAvailable() ? 54 : 0;
  const bottomPad = Math.max(insets.bottom, Platform.OS === 'web' ? 34 : 10) + tabBarOffset;

  if (scopedOut) {
    return (
      <View style={{ flex: 1, backgroundColor: c.background, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 }}>
        <Text style={{ fontFamily: F.medium, fontSize: 17, color: c.foreground, textAlign: 'center' }}>Conversation unavailable</Text>
        <Text style={{ fontFamily: F.regular, fontSize: 14, lineHeight: 20, color: c.mutedForeground, textAlign: 'center', marginTop: 8 }}>
          It does not belong to the currently paired home identity. Pair the right device or pick another conversation.
        </Text>
        {showBack ? (
          <Pressable testID="chat-back" accessibilityLabel="Back to Chat" onPress={back} hitSlop={12} style={{ marginTop: 16, padding: 10 }}>
            <Feather name="chevron-left" size={26} color={c.foreground} />
          </Pressable>
        ) : null}
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      {!inTab ? (
        <View style={[st.header, { paddingTop: showBack ? top + 6 : 8, borderBottomColor: c.border }]}>
          {showBack ? (
            <Pressable onPress={back} hitSlop={12} testID="chat-back" accessibilityLabel="Back to Chat">
              <Feather name="chevron-left" size={26} color={c.foreground} />
            </Pressable>
          ) : null}
          <View style={{ flex: 1, alignItems: showBack ? 'center' : 'flex-start' }}>
            <Text numberOfLines={1} style={{ fontFamily: F.medium, fontSize: 16, color: c.foreground }}>{title}</Text>
            {settings.assistantMode !== 'demo' ? (
              <Text style={{ fontFamily: F.mono, fontSize: 10, letterSpacing: 1, color: connectionStatus === 'connected' ? c.accent : c.destructive }}>
                {connectionStatus === 'connected'
                  ? 'ME HOME · PRIVATE CONNECTION'
                  : connectionStatus === 'connecting'
                    ? 'ME HOME · CONNECTING'
                    : connectionStatus === 'offline'
                      ? 'ME HOME · OFFLINE · WILL QUEUE'
                      : connectionStatus === 'error'
                        ? 'ME HOME · CONNECTION ERROR'
                        : 'ME HOME · DISCONNECTED'}
              </Text>
            ) : null}
          </View>
          <Pressable
            testID="start-mock-call"
            accessibilityRole="button"
            accessibilityLabel="Start simulated call"
            disabled={activeCallId !== null}
            onPress={startCall}
            style={{ padding: 8, opacity: activeCallId === null ? 1 : 0.38 }}
          >
            <Feather name="phone" size={19} color={c.accent} />
          </Pressable>
        </View>
      ) : null}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding" keyboardVerticalOffset={0}>
        <FlatList<Message>
          style={{ flex: 1 }}
          inverted={data.length > 0}
          data={data}
          keyExtractor={(m) => m.id}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: 16, gap: 10, flexGrow: 1 }}
          ListHeaderComponent={isTyping ? <Typing /> : undefined}
          ListEmptyComponent={
            <View style={st.empty}>
              <MeMark size={38} />
              <Text style={{ fontFamily: F.medium, fontSize: 18, color: c.foreground, marginTop: 13 }}>A conversation with Me</Text>
              <Text style={{ fontFamily: F.regular, fontSize: 14, lineHeight: 20, color: c.mutedForeground, textAlign: 'center', marginTop: 6, maxWidth: 285 }}>
                {settings.assistantMode === 'demo'
                  ? 'Messages are stored unencrypted on this device. Please use fictional details.'
                  : connectionStatus === 'connected'
                ? 'Your messages go directly to Me Home over HTTPS, not a cloud model. Saved chat history is local and not encrypted in this prototype.'
                : connectionStatus === 'offline'
                  ? 'Me Home is offline. Messages queue on this device and send when it reconnects — nothing is claimed as run until the home accepts it.'
                  : 'Connect to Me Home in the Me tab to send private messages. Nothing is sent while disconnected.'}
              </Text>
            </View>
          }
          renderItem={({ item }: ListRenderItemInfo<Message>) => <Bubble m={item} />}
        />
        {chatError ? (
          <View testID="chat-send-error" accessibilityLiveRegion="assertive" style={[st.error, { backgroundColor: c.muted, borderColor: c.border }]}>
            <Text style={{ flex: 1, fontFamily: F.regular, fontSize: 13, lineHeight: 18, color: c.destructive }}>{chatError}</Text>
            <Pressable
              testID="retry-chat-send"
              accessibilityRole="button"
              accessibilityLabel="Retry sending the last message to Me Home"
              onPress={() => id && retryMessage(id)}
              style={{ padding: 6 }}
            >
              <Text style={{ fontFamily: F.medium, fontSize: 13, color: c.accent }}>Retry</Text>
            </Pressable>
          </View>
        ) : null}
        {settings.assistantMode === 'home' ? <TaskPanel conversationId={id ?? null} /> : null}
        <View style={[st.inputBar, { paddingBottom: bottomPad, borderTopColor: c.border, backgroundColor: c.background }]}>
          <TextInput
            ref={inputRef}
            testID="chat-input"
            value={text}
            onChangeText={setText}
            editable={canSend}
            placeholder={settings.assistantMode === 'demo' ? 'Message Me' : canSend ? 'Message Me Home' : 'Connect Me Home to send'}
            placeholderTextColor={c.mutedForeground}
            multiline
            style={[st.input, { backgroundColor: c.card, borderColor: c.border, color: c.foreground }]}
          />
          <Pressable testID="chat-send" accessibilityLabel="Send message" onPress={send} disabled={!canSend || isTyping || !text.trim()} style={[st.send, { backgroundColor: canSend && !isTyping && text.trim() ? c.accent : c.muted }]}>
            <Feather name="arrow-up" size={20} color={canSend && !isTyping && text.trim() ? c.accentForeground : c.mutedForeground} />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

function Bubble({ m }: { m: Message }) {
  const c = useColors();
  const mine = m.role === 'user';
  const visibleText = m.text
    .replace(/^\[Scripted demo reply\]\s*/, '')
    .replace(/^\(Fictional demo\)\s*/, '');
  return (
    <View style={{ alignItems: mine ? 'flex-end' : 'flex-start' }}>
      <View style={[st.bubble, mine ? { backgroundColor: c.primary } : { backgroundColor: c.card, borderColor: c.border, borderWidth: StyleSheet.hairlineWidth }]}>
        <Text style={{ fontFamily: F.regular, fontSize: 15, lineHeight: 21, color: mine ? c.primaryForeground : c.foreground }}>
          {visibleText}
        </Text>
      </View>
    </View>
  );
}

function Typing() {
  const c = useColors();
  const { settings } = useMe();
  return (
    <View style={[st.bubble, { backgroundColor: c.card, borderColor: c.border, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 8, alignItems: 'center' }]}>
      <MeMark size={14} />
      <Text style={{ fontFamily: F.regular, fontSize: 13, color: c.mutedForeground }}>{settings.assistantMode === 'demo' ? 'Me is replying' : 'Me Home is replying'}</Text>
    </View>
  );
}

const st = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  bubble: { maxWidth: '82%', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 16 },
  empty: { flex: 1, minHeight: 280, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  error: { marginHorizontal: 12, marginBottom: 8, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', gap: 10 },
  inputBar: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 12, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth },
  input: { flex: 1, minHeight: 42, maxHeight: 120, borderRadius: 21, borderWidth: 1, paddingHorizontal: 16, paddingTop: 11, paddingBottom: 11, fontFamily: F.regular, fontSize: 15 },
  send: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
});
