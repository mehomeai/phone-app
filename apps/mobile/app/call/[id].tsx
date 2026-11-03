import { Feather } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Avatar, F, Hydrated, MeMark, tap, useTopInset } from '@/components/ui';
import { useMe } from '@/context/MeContext';
import { useColors } from '@/hooks/useColors';

export default function CallScreen() {
  return (
    <Hydrated>
      <MockCall />
    </Hydrated>
  );
}

function MockCall() {
  const c = useColors();
  const top = useTopInset();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { conversations, visibleChats, settings, profiles, activeCallId, beginCall, endCall } = useMe();
  const [muted, setMuted] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef(Date.now());
  // Scoped lookup: a deep link outside the current identity resolves to
  // nothing instead of leaking a cached private title/profile.
  const conversation = (settings.assistantMode === 'home' ? visibleChats : conversations).find((x) => x.id === id);
  const scopedOut = settings.assistantMode === 'home' && !!id && !conversation;
  const profile = profiles.find((x) => x.id === conversation?.profileId);
  const ownsCall = activeCallId === id;

  useEffect(() => {
    if (activeCallId === null) beginCall(id);
    return () => endCall(id);
  }, [id]);

  useEffect(() => {
    if (!ownsCall) return;
    startedAt.current = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [ownsCall]);

  const hangUp = () => {
    tap();
    endCall(id);
    if (router.canGoBack()) router.back();
    else if (id) router.replace({ pathname: '/chat/[id]', params: { id } });
    else router.replace('/chats');
  };  const formatTime = (n: number) => `${Math.floor(n / 60).toString().padStart(2, '0')}:${(n % 60).toString().padStart(2, '0')}`;

  if (scopedOut) {
    return (
      <View style={[st.page, { backgroundColor: c.background }]}>
        <View style={[st.header, { paddingTop: top + 10 }]}>
          <MeMark size={25} />
          <Text style={{ fontFamily: F.medium, fontSize: 17, color: c.foreground }}>Me</Text>
        </View>
        <View style={st.center}>
          <Text style={[st.name, { color: c.foreground, textAlign: 'center' }]}>Call unavailable</Text>
          <Text style={[st.disclosure, { color: c.mutedForeground, borderColor: c.border }]}>
            This conversation does not belong to the currently paired home identity. Simulated calls never touch private data outside your scope.
          </Text>
          <Pressable testID="hang-up" accessibilityRole="button" accessibilityLabel="End simulated call" onPress={hangUp} hitSlop={12} style={[st.hangup, { backgroundColor: c.destructive, marginTop: 24 }]}>
            <Feather name="phone-off" size={24} color={c.destructiveForeground} />
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={[st.page, { backgroundColor: c.background }]}>
      <View style={[st.header, { paddingTop: top + 10 }]}>
        <MeMark size={25} />
        <Text style={{ fontFamily: F.medium, fontSize: 17, color: c.foreground }}>Me</Text>
      </View>
      <View style={st.center}>
        {profile ? <Avatar name={profile.name} size={100} active /> : <MeMark size={100} />}
        <Text style={[st.name, { color: c.foreground }]}>{profile?.name ?? 'Conversation'}</Text>
        <Text style={{ fontFamily: F.regular, fontSize: 14, color: c.mutedForeground, marginTop: 3 }} numberOfLines={1}>
          {conversation?.title ?? 'Me conversation'}
        </Text>
        <View style={[st.status, { backgroundColor: c.accentSoft }]}>
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: ownsCall ? c.accent : c.destructive }} />
          <Text testID="call-status" style={{ fontFamily: F.mono, fontSize: 11, letterSpacing: 1, color: c.foreground }}>
            {ownsCall ? `SIMULATED  ·  ${formatTime(elapsed)}` : activeCallId && activeCallId !== id ? 'ANOTHER CALL IS ACTIVE' : 'CALL ENDED'}
          </Text>
        </View>
        <Text style={[st.disclosure, { color: c.mutedForeground, borderColor: c.border }]}>
          No audio is connected. This screen simulates call controls only; no microphone permission is requested and nothing is being recorded.
        </Text>
      </View>

      <View style={[st.controls, { paddingBottom: 34 }]}>
        <Pressable
          testID="mute-call"
          accessibilityRole="button"
          accessibilityLabel={muted ? 'Unmute simulated call' : 'Mute simulated call'}
          disabled={!ownsCall}
          onPress={() => { tap(); setMuted((x) => !x); }}
          style={[st.control, { backgroundColor: muted ? c.accent : c.card, borderColor: c.border, opacity: ownsCall ? 1 : 0.5 }]}
        >
          <Feather name={muted ? 'mic-off' : 'mic'} size={23} color={muted ? c.accentForeground : c.foreground} />
          <Text style={{ fontFamily: F.medium, fontSize: 12, color: muted ? c.accentForeground : c.foreground }}>{muted ? 'Unmute' : 'Mute'}</Text>
        </Pressable>
        <Pressable
          testID="hang-up"
          accessibilityRole="button"
          accessibilityLabel="End simulated call"
          onPress={hangUp}
          style={[st.hangup, { backgroundColor: c.destructive }]}
        >
          <Feather name="phone-off" size={24} color={c.destructiveForeground} />
        </Pressable>
        <View style={{ width: 74 }} />
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  page: { flex: 1 },
  header: { paddingHorizontal: 22, paddingBottom: 14, flexDirection: 'row', alignItems: 'center', gap: 10 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28, paddingBottom: 24 },
  name: { fontFamily: F.medium, fontSize: 28, letterSpacing: -0.8, marginTop: 22 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 13, paddingVertical: 8, borderRadius: 999, marginTop: 18 },
  disclosure: { textAlign: 'center', fontFamily: F.regular, fontSize: 13, lineHeight: 19, marginTop: 24, paddingHorizontal: 16, paddingVertical: 12, borderWidth: 1, borderRadius: 12, maxWidth: 330 },
  controls: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 24 },
  control: { width: 74, height: 74, borderRadius: 37, borderWidth: 1, alignItems: 'center', justifyContent: 'center', gap: 5 },
  hangup: { width: 68, height: 68, borderRadius: 34, alignItems: 'center', justifyContent: 'center', transform: [{ rotate: '135deg' }] },
});
