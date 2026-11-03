import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Card, Eyebrow, F, StatusDot } from '@/components/ui';
import { useMe } from '@/context/MeContext';
import { useColors } from '@/hooks/useColors';

export function OverviewPanel({ onDevice, onSettings }: { onDevice: () => void; onSettings: () => void }) {
  const c = useColors();
  const { activeProfile, settings, visibleChats, saved, connectionStatus } = useMe();
  // Scoped by identity in home mode: never another user's cached rows.
  const myConvs = visibleChats;
  const isChild = activeProfile.role === 'child';
  const rules = [
    settings.approvalRequired ? 'Outside actions wait for approval' : 'Outside actions do not ask first',
    isChild ? 'A parent can review this space' : 'Only you read your conversations',
    isChild ? 'Me asks for your guess before answering' : 'Me answers directly',
  ];

  return (
    <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={{ paddingTop: 12, paddingBottom: 130, paddingHorizontal: 20 }}>
      <Text style={[st.hello, { color: c.foreground }]}>Good to see you, {activeProfile.name.split(' ')[0]}.</Text>
      <Text style={{ fontFamily: F.regular, fontSize: 15, lineHeight: 22, color: c.mutedForeground, marginTop: 8 }}>
        Your intelligence, your data, your rules. Connect Me Home for direct, private chat.
      </Text>

      <Pressable onPress={() => onDevice()}>
        <Card style={{ marginTop: 24 }}>
          <View style={st.rowBetween}>
            <Eyebrow>Me Home</Eyebrow>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              {settings.assistantMode === 'home' ? <StatusDot on={connectionStatus === 'connected'} /> : null}
              <Text style={{ fontFamily: F.mono, fontSize: 11, color: connectionStatus === 'error' ? c.destructive : c.mutedForeground }}>
              {settings.assistantMode === 'demo'
                ? 'DISCONNECTED'
                : connectionStatus === 'connected'
                  ? 'CONNECTED'
                  : connectionStatus === 'connecting'
                    ? 'CONNECTING'
                    : connectionStatus === 'offline'
                      ? 'OFFLINE · QUEUEING'
                      : connectionStatus === 'error'
                        ? 'CONNECTION ERROR'
                        : 'DISCONNECTED'}
              </Text>
            </View>
          </View>
          <Text style={{ fontFamily: F.medium, fontSize: 18, color: c.foreground, marginTop: 10 }}>
            {settings.assistantMode === 'demo'
              ? 'Private assistant not connected'
              : connectionStatus === 'connected'
                ? 'Private home connection ready'
                : connectionStatus === 'offline'
                  ? 'Home offline — messages queue here'
                  : 'Chat is paused until Me Home connects'}
          </Text>
          <Text style={{ fontFamily: F.regular, fontSize: 13, color: c.mutedForeground, marginTop: 4 }}>
            {settings.assistantMode === 'demo'
              ? 'Connect Me Home to use your home assistant.'
              : 'Chat connects directly to your home service. There is no cloud-model fallback.'}
          </Text>
        </Card>
      </Pressable>

      <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
        <Pressable style={{ flex: 1 }} onPress={() => router.navigate('/chats')}>
          <Card>
            <Feather name="message-circle" size={18} color={c.accent} />
            <Text style={[st.stat, { color: c.foreground }]}>{myConvs.length}</Text>
            <Text style={{ fontFamily: F.regular, fontSize: 13, color: c.mutedForeground }}>conversations</Text>
          </Card>
        </Pressable>
        <Pressable style={{ flex: 1 }} onPress={() => router.navigate('/feed')}>
          <Card>
            <Feather name="bookmark" size={18} color={c.accent} />
            <Text style={[st.stat, { color: c.foreground }]}>{saved.length}</Text>
            <Text style={{ fontFamily: F.regular, fontSize: 13, color: c.mutedForeground }}>saved to learn</Text>
          </Card>
        </Pressable>
      </View>

      <Eyebrow style={{ marginTop: 28, marginBottom: 12 }}>{isChild ? 'Rules set by a parent' : 'Your rules'}</Eyebrow>
      <Card style={{ paddingVertical: 4 }}>
        {rules.map((r, i) => (
          <View key={r} style={[st.rule, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border }]}>
            <Feather name="check" size={15} color={c.accent} />
            <Text style={{ fontFamily: F.regular, fontSize: 14, color: c.foreground, flex: 1 }}>{r}</Text>
          </View>
        ))}
      </Card>
      <Pressable onPress={() => onSettings()} style={{ marginTop: 12, alignSelf: 'flex-start' }}>
        <Text style={{ fontFamily: F.medium, fontSize: 14, color: c.accent }}>Change rules</Text>
      </Pressable>
    </ScrollView>
  );
}

const st = StyleSheet.create({
  hello: { fontFamily: F.medium, fontSize: 32, letterSpacing: -1.4, lineHeight: 36, marginTop: 28 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  stat: { fontFamily: F.medium, fontSize: 28, letterSpacing: -1, marginTop: 10 },
  rule: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
});
