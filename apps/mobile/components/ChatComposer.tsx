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
import { maskApprovalArgs } from '@/lib/home-client';
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
    upstreamSelection,
    upstreamSetupMessage,
    isNativeConversation,
    nativeTasksByConv,
    nativeTasksLoading,
    nativeTasksError,
    refreshNativeTasks,
    retryNativeTask,
    nativeApprovals,
    nativeApprovalsLoading,
    nativeApprovalsError,
    nativeApprovalsBusy,
    refreshNativeApprovals,
    decideNativeApproval,
    nativeAnswers,
    setNativeAnswer,
    respondNativeQuestion,
    nativeWatchState,
  } = useMe();
  const [text, setText] = useState('');
  const inputRef = useRef<React.ComponentRef<typeof TextInput>>(null);
  const currentId = useRef<string | null>(conversationId);
  const id = conversationId ?? currentId.current;
  // Scoped lookup: a deep link or stale id outside the current identity
  // resolves to nothing instead of leaking cached private content. The
  // list screen already renders visibleChats only; the composer uses the
  // same scope in demo mode too (profile-filtered), so a direct link to
  // another profile's chat fails closed instead of rendering it.
  const conv = visibleChats.find((x) => x.id === id);
  const scopedOut = !!id && !conv;
  const messages = conv?.messages ?? [];
  const isTyping = !!(id && typing[id]);
  const chatError = id ? chatErrors[id] : undefined;
  // FULL requested but the home is not set up: refuse honestly (never send
  // into the wrong engine). Legacy/demo behavior is unchanged.
  const setupBlocked = settings.assistantMode === 'home' && upstreamSelection === 'setup-needed';
  const canSend = (settings.assistantMode === 'demo' || connectionStatus === 'connected' || connectionStatus === 'offline') && !setupBlocked;
  const nativeActive = settings.assistantMode === 'home' && !!id && isNativeConversation(id);
  const watchState = id ? nativeWatchState[id] : undefined;
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
      <View testID="chat-access-denied" style={{ flex: 1, backgroundColor: c.background, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 }}>
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
                {upstreamSelection === 'setup-needed'
                  ? 'ME HOME · SETUP NEEDED'
                  : connectionStatus === 'connected'
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
        {setupBlocked && upstreamSetupMessage ? (
          <View testID="upstream-setup-needed" accessibilityLiveRegion="assertive" style={[st.error, { backgroundColor: c.muted, borderColor: c.border }]}>
            <Text style={{ flex: 1, fontFamily: F.regular, fontSize: 13, lineHeight: 18, color: c.destructive }}>{upstreamSetupMessage}</Text>
          </View>
        ) : null}
        {settings.assistantMode === 'home' && !nativeActive ? <TaskPanel conversationId={id ?? null} /> : null}
        {nativeActive && id ? (
          <NativeTaskSection
            tasks={nativeTasksByConv[id] ?? []}
            loading={!!nativeTasksLoading[id]}
            error={nativeTasksError[id] ?? null}
            onRefresh={() => { void refreshNativeTasks(id); }}
            onRetry={(taskId) => { void retryNativeTask(taskId); }}
          />
        ) : null}
        {nativeActive ? (
          <NativeRequestsSection
            inbox={nativeApprovals}
            loading={nativeApprovalsLoading}
            error={nativeApprovalsError}
            busy={nativeApprovalsBusy}
            answers={nativeAnswers}
            onRefresh={() => { void refreshNativeApprovals(); }}
            onDecide={(requestId, decision) => { void decideNativeApproval(requestId, decision); }}
            onAnswerText={(questionId, answer) => { setNativeAnswer(questionId, answer); }}
            onRespond={(questionId) => { void respondNativeQuestion(questionId); }}
          />
        ) : null}
        {nativeActive && watchState === 'stale' && id ? (
          <View testID="native-still-working" style={[st.error, { backgroundColor: c.muted, borderColor: c.border }]}>
            <Text style={{ flex: 1, fontFamily: F.regular, fontSize: 13, lineHeight: 18, color: c.mutedForeground }}>
              Still working in the background. New replies will appear here on their own.
            </Text>
            <Pressable
              testID="native-refresh-now"
              accessibilityRole="button"
              accessibilityLabel="Check for new replies now"
              onPress={() => openConversation(id)}
              style={{ padding: 6 }}
            >
              <Text style={{ fontFamily: F.medium, fontSize: 13, color: c.accent }}>Check now</Text>
            </Pressable>
          </View>
        ) : null}
        <View style={[st.inputBar, { paddingBottom: bottomPad, borderTopColor: c.border, backgroundColor: c.background }]}>
          <TextInput
            ref={inputRef}
            testID="chat-input"
            value={text}
            onChangeText={setText}
            editable={canSend}
            placeholder={settings.assistantMode === 'demo' ? 'Message Me' : setupBlocked ? 'Home setup needed' : canSend ? 'Message Me' : 'Connect Me Home to send'}
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

/**
 * Tasks for this conversation. Failed work can be retried here (it runs
 * once more in this conversation); questions that need input are answered
 * below in Requests.
 */
function NativeTaskSection({
  tasks,
  loading,
  error,
  onRefresh,
  onRetry,
}: {
  tasks: import('@/lib/home-client').NativeBotTask[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onRetry: (taskId: string) => void;
}) {
  const c = useColors();
  const open = tasks.filter((t) => t.status === 'needs_input' || t.status === 'working' || t.status === 'ready_for_review');
  const failed = tasks.filter((t) => t.status === 'failed');
  if (!loading && !error && open.length === 0 && failed.length === 0) return null;
  return (
    <View testID="native-tasks" style={[st.error, { backgroundColor: c.muted, borderColor: c.border, flexDirection: 'column', alignItems: 'stretch', gap: 6 }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Text style={{ flex: 1, fontFamily: F.medium, fontSize: 13, color: c.mutedForeground }}>
          Tasks · {loading ? 'loading' : `${open.length} open · ${failed.length} failed`}
        </Text>
        <Pressable testID="native-tasks-refresh" accessibilityRole="button" accessibilityLabel="Refresh tasks" onPress={onRefresh} style={{ padding: 6 }}>
          <Feather name="refresh-cw" size={15} color={c.mutedForeground} />
        </Pressable>
      </View>
      {error ? (
        <Text style={{ fontFamily: F.regular, fontSize: 13, color: c.destructive }}>{error}</Text>
      ) : null}
      {open.filter((t) => t.status === 'needs_input').map((t) => (
        <Text key={t.id} style={{ fontFamily: F.regular, fontSize: 13, lineHeight: 18, color: c.foreground }}>
          {t.title} — needs input. Answer it in Requests below.
        </Text>
      ))}
      {failed.map((t) => (
        <View key={t.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Text style={{ flex: 1, fontFamily: F.regular, fontSize: 13, lineHeight: 18, color: c.foreground }}>
            {t.title} — didn&apos;t finish{t.failure ? `: ${t.failure}` : ''}.
          </Text>
          <Pressable testID={`native-task-retry-${t.id}`} accessibilityRole="button" accessibilityLabel={`Try ${t.title} again`} onPress={() => onRetry(t.id)} style={{ padding: 6 }}>
            <Text style={{ fontFamily: F.medium, fontSize: 13, color: c.accent }}>Try again</Text>
          </Pressable>
        </View>
      ))}
      {open.filter((t) => t.status !== 'needs_input').map((t) => (
        <Text key={t.id} style={{ fontFamily: F.regular, fontSize: 13, lineHeight: 18, color: c.mutedForeground }}>
          {t.title} — {t.status.replace(/_/g, ' ')}{t.next ? ` · ${t.next}` : ''}
        </Text>
      ))}
    </View>
  );
}

/**
 * Your requests inbox: things Me is waiting on you for, across your chats.
 * Approve or deny each request explicitly, and answer questions directly —
 * these decisions always go through as their own explicit action.
 */
function NativeRequestsSection({
  inbox,
  loading,
  error,
  busy,
  answers,
  onRefresh,
  onDecide,
  onAnswerText,
  onRespond,
}: {
  inbox: import('@/lib/home-client').NativeApprovalInbox | null;
  loading: boolean;
  error: string | null;
  busy: Record<string, boolean>;
  answers: Record<string, string>;
  onRefresh: () => void;
  onDecide: (requestId: string, decision: import('@/lib/home-client').NativeApprovalDecision) => void;
  onAnswerText: (questionId: string, answer: string) => void;
  onRespond: (questionId: string) => void;
}) {
  const c = useColors();
  const pending = (inbox?.requests ?? []).filter((r) => r.status === 'pending');
  const questions = inbox?.questions ?? [];
  if (!loading && !error && pending.length === 0 && questions.length === 0) return null;
  return (
    <View testID="native-requests" style={[st.error, { backgroundColor: c.muted, borderColor: c.border, flexDirection: 'column', alignItems: 'stretch', gap: 10 }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Text style={{ flex: 1, fontFamily: F.medium, fontSize: 13, color: c.mutedForeground }}>
          Requests · {loading ? 'loading' : `${pending.length + questions.length} waiting on you`}
        </Text>
        <Pressable testID="native-requests-refresh" accessibilityRole="button" accessibilityLabel="Refresh requests" onPress={onRefresh} style={{ padding: 6 }}>
          <Feather name="refresh-cw" size={15} color={c.mutedForeground} />
        </Pressable>
      </View>
      {error ? (
        <Text style={{ fontFamily: F.regular, fontSize: 13, color: c.destructive }}>{error}</Text>
      ) : null}
      {pending.map((request) => {
        const bot = request.botId ?? request.action?.botId ?? 'Me';
        const tool = request.toolRef ?? request.action?.toolRef ?? 'something';
        const what = `${request.effect ?? request.action?.effect ?? 'use'} · ${request.scope ?? request.action?.scope ?? ''}`.trim();
        const detailSource = request.preview ?? request.action?.args;
        const detail = detailSource === undefined || detailSource === null
          ? null
          : JSON.stringify(maskApprovalArgs(request.toolRef ?? request.action?.toolRef ?? '', detailSource), null, 2);
        const isTaskPolicy = request.action?.policy?.source === 'task';
        const isBusy = !!busy[request.id];
        return (
          <View key={request.id} testID={`native-request-${request.id}`} style={{ gap: 8 }}>
            <Text style={{ fontFamily: F.medium, fontSize: 14, color: c.foreground }}>
              {bot} asks to use {tool}
            </Text>
            <Text style={{ fontFamily: F.regular, fontSize: 13, color: c.mutedForeground }}>{what}</Text>
            {detail ? (
              <Text style={{ fontFamily: F.mono, fontSize: 11, color: c.mutedForeground }}>{detail.slice(0, 600)}</Text>
            ) : null}
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              <Pressable
                testID={`native-approve-once-${request.id}`}
                accessibilityRole="button"
                accessibilityLabel={`Allow ${tool} this once`}
                disabled={isBusy}
                onPress={() => onDecide(request.id, 'allow_once')}
                style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10, backgroundColor: c.accent, opacity: isBusy ? 0.5 : 1 }}
              >
                <Text style={{ fontFamily: F.medium, fontSize: 13, color: c.accentForeground }}>Allow once</Text>
              </Pressable>
              {isTaskPolicy ? null : (
                <Pressable
                  testID={`native-approve-always-${request.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={`Always allow ${tool}`}
                  disabled={isBusy}
                  onPress={() => onDecide(request.id, 'allow_always')}
                  style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: c.border, opacity: isBusy ? 0.5 : 1 }}
                >
                  <Text style={{ fontFamily: F.medium, fontSize: 13, color: c.foreground }}>Always allow this</Text>
                </Pressable>
              )}
              <Pressable
                testID={`native-deny-${request.id}`}
                accessibilityRole="button"
                accessibilityLabel={`Deny ${tool}`}
                disabled={isBusy}
                onPress={() => onDecide(request.id, 'deny')}
                style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: c.border, opacity: isBusy ? 0.5 : 1 }}
              >
                <Text style={{ fontFamily: F.medium, fontSize: 13, color: c.destructive }}>Deny</Text>
              </Pressable>
            </View>
          </View>
        );
      })}
      {questions.map((question) => {
        const draft = answers[question.id] ?? '';
        const isBusy = !!busy[question.id];
        return (
          <View key={question.id} testID={`native-question-${question.id}`} style={{ gap: 8 }}>
            <Text style={{ fontFamily: F.medium, fontSize: 14, color: c.foreground }}>{question.botId}</Text>
            <Text style={{ fontFamily: F.regular, fontSize: 13, lineHeight: 18, color: c.foreground }}>{question.question}</Text>
            {question.why ? (
              <Text style={{ fontFamily: F.regular, fontSize: 13, color: c.mutedForeground }}>{question.why}</Text>
            ) : null}
            <TextInput
              testID={`native-answer-${question.id}`}
              value={draft}
              onChangeText={(answer) => onAnswerText(question.id, answer)}
              placeholder="Your answer"
              placeholderTextColor={c.mutedForeground}
              multiline
              editable={!isBusy}
              style={{ borderWidth: 1, borderColor: c.border, borderRadius: 10, padding: 10, fontFamily: F.regular, fontSize: 14, color: c.foreground, backgroundColor: c.background }}
            />
            <Pressable
              testID={`native-send-answer-${question.id}`}
              accessibilityRole="button"
              accessibilityLabel="Send answer"
              disabled={isBusy || !draft.trim()}
              onPress={() => onRespond(question.id)}
              style={{ alignSelf: 'flex-start', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10, backgroundColor: c.accent, opacity: isBusy || !draft.trim() ? 0.5 : 1 }}
            >
              <Text style={{ fontFamily: F.medium, fontSize: 13, color: c.accentForeground }}>Send answer</Text>
            </Pressable>
          </View>
        );
      })}
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
