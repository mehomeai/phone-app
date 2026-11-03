import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useState } from 'react';
import { Alert, Platform, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { Avatar, Button, Card, Eyebrow, F, tap } from '@/components/ui';
import { useMe } from '@/context/MeContext';
import { useColors } from '@/hooks/useColors';
import { roleLabel } from '@/lib/data';
import type { Profile, Role } from '@/lib/types';

const ROLES: Role[] = ['parent', 'adult', 'child'];

function ask(title: string, msg: string, action: string, onYes: () => void) {
  if (Platform.OS === 'web') {
    if (window.confirm(`${title}\n\n${msg}`)) onYes();
    return;
  }
  Alert.alert(title, msg, [{ text: 'Cancel', style: 'cancel' }, { text: action, style: 'destructive', onPress: onYes }]);
}

export function SettingsPanel() {
  const c = useColors();
  const {
    profiles, activeProfile, setActiveProfile, addProfile, settings, updateSettings, resetDemo,
    connectionStatus, requestedUpstreamMode, setRequestedUpstreamMode, upstreamSelection,
    upstreamSetupMessage, upstreamBots, upstreamBotsLoading, upstreamBotsError, refreshUpstreamBots,
  } = useMe();
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const isChild = activeProfile.role === 'child';

  return (
    <KeyboardAwareScrollViewCompat style={{ backgroundColor: c.background }} contentContainerStyle={{ paddingBottom: 140 }} bottomOffset={40}>
      <View style={{ paddingHorizontal: 20 }}>
        <Eyebrow style={{ marginBottom: 10 }}>Household</Eyebrow>
        <Card style={{ paddingVertical: 4 }}>
          {profiles.map((p, i) => (
            <View key={p.id} style={i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border } : undefined}>
              {editing === p.id ? (
                <ProfileForm initial={p} onDone={() => setEditing(null)} />
              ) : (
                <View style={[st.row, { paddingVertical: 12 }]}>
                  <Avatar name={p.name} size={36} active={p.id === activeProfile.id} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontFamily: F.medium, fontSize: 15, color: c.foreground }}>{p.name}</Text>
                    <Text style={{ fontFamily: F.mono, fontSize: 10, letterSpacing: 1, color: c.mutedForeground }}>
                      {roleLabel(p.role).toUpperCase()}{p.id === activeProfile.id ? '  ·  THIS PHONE' : ''}
                    </Text>
                  </View>
                  {p.id !== activeProfile.id ? (
                    <Pressable
                      testID={`use-profile-${p.id}`}
                      accessibilityRole="button"
                      accessibilityLabel={`Use ${p.name} on this phone`}
                      onPress={() => { tap(); setActiveProfile(p.id); }}
                      hitSlop={8}
                      style={{ paddingHorizontal: 8, paddingVertical: 6 }}
                    >
                      <Text style={{ fontFamily: F.medium, fontSize: 12, color: c.accent }}>Use</Text>
                    </Pressable>
                  ) : null}
                  <Pressable testID={`edit-${p.id}`} hitSlop={10} accessibilityLabel={`Edit ${p.name}`} onPress={() => { setAdding(false); setEditing(p.id); }}>
                    <Feather name="edit-2" size={17} color={c.mutedForeground} />
                  </Pressable>
                </View>
              )}
            </View>
          ))}
          {adding ? (
            <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border }}>
              <ProfileForm onDone={() => setAdding(false)} onCreate={addProfile} />
            </View>
          ) : (
            <Pressable testID="add-profile" onPress={() => { setEditing(null); setAdding(true); }} style={[st.row, { paddingVertical: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border }]}>
              <Feather name="plus" size={18} color={c.accent} />
              <Text style={{ fontFamily: F.medium, fontSize: 15, color: c.accent }}>Add a person</Text>
            </Pressable>
          )}
        </Card>

        <Eyebrow style={{ marginTop: 26, marginBottom: 10 }}>Rules</Eyebrow>
        <Card style={{ paddingVertical: 4 }}>
          <View style={[st.row, { paddingVertical: 14 }]}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontFamily: F.medium, fontSize: 15, color: c.foreground }}>Ask before outside actions</Text>
              <Text style={{ fontFamily: F.regular, fontSize: 13, color: c.mutedForeground, marginTop: 2 }}>
                {isChild ? 'Only a parent can change this.' : 'A saved preference. The prototype takes no outside actions.'}
              </Text>
            </View>
            <Switch
              testID="approval-toggle"
              value={settings.approvalRequired}
              disabled={isChild}
              onValueChange={(v) => { tap(); updateSettings({ approvalRequired: v }); }}
              trackColor={{ true: c.accent, false: c.input }}
              thumbColor={c.card}
            />
          </View>
          <Pressable
            testID="manage-me-home"
            accessibilityRole="button"
            onPress={() => router.setParams({ section: 'device' })}
            style={[st.row, { paddingVertical: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border }]}
          >
            <View style={{ flex: 1 }}>
              <Text style={{ fontFamily: F.medium, fontSize: 15, color: c.foreground }}>Me Home connection</Text>
              <Text style={{ fontFamily: F.regular, fontSize: 13, color: c.mutedForeground, marginTop: 2 }}>
                {settings.assistantMode === 'demo'
                  ? 'Disconnected'
                  : connectionStatus === 'connected'
                    ? 'Connected directly over HTTPS'
                    : connectionStatus === 'connecting'
                      ? 'Checking connection'
                      : connectionStatus === 'offline'
                        ? 'Home offline — messages queue on this device'
                        : connectionStatus === 'error'
                          ? 'Connection error'
                          : 'Disconnected'}
              </Text>
            </View>
            <Feather name="chevron-right" size={18} color={c.mutedForeground} />
          </Pressable>
        </Card>

        {settings.assistantMode === 'home' ? (
          <>
            <Eyebrow style={{ marginTop: 26, marginBottom: 10 }}>Assistant</Eyebrow>
            <Card style={{ paddingVertical: 4 }}>
              <View style={[st.row, { paddingVertical: 14 }]}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontFamily: F.medium, fontSize: 15, color: c.foreground }}>Full agent mode</Text>
                  <Text style={{ fontFamily: F.regular, fontSize: 13, color: c.mutedForeground, marginTop: 2 }}>
                    {upstreamSelection === 'full'
                      ? `On — your chats run on your home's full agent${upstreamBots ? ` (${upstreamBots.length} available)` : ''}.`
                      : upstreamSelection === 'setup-needed'
                        ? 'Requested, but this home is not set up for it yet.'
                        : 'Off — classic replies.'}
                  </Text>
                  {upstreamSelection === 'setup-needed' && upstreamSetupMessage ? (
                    <Text testID="upstream-setup-message" style={{ fontFamily: F.regular, fontSize: 13, color: c.destructive, marginTop: 6 }}>
                      {upstreamSetupMessage}
                    </Text>
                  ) : null}
                  {upstreamBotsError ? (
                    <Text style={{ fontFamily: F.regular, fontSize: 13, color: c.destructive, marginTop: 6 }}>
                      Couldn&apos;t load the list: {upstreamBotsError}
                    </Text>
                  ) : null}
                </View>
                <Switch
                  testID="upstream-mode-toggle"
                  value={requestedUpstreamMode === 'full'}
                  disabled={connectionStatus !== 'connected'}
                  onValueChange={(v) => { tap(); setRequestedUpstreamMode(v ? 'full' : 'legacy'); }}
                  trackColor={{ true: c.accent, false: c.input }}
                  thumbColor={c.card}
                />
              </View>
              {requestedUpstreamMode === 'full' && upstreamSelection === 'full' ? (
                <Pressable
                  testID="refresh-upstream-bots"
                  accessibilityRole="button"
                  accessibilityLabel="Refresh the assistant list"
                  onPress={() => { tap(); void refreshUpstreamBots(); }}
                  disabled={upstreamBotsLoading}
                  style={[st.row, { paddingVertical: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border, opacity: upstreamBotsLoading ? 0.5 : 1 }]}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontFamily: F.medium, fontSize: 15, color: c.foreground }}>
                      {upstreamBotsLoading ? 'Loading…' : 'Refresh the assistant list'}
                    </Text>
                    {upstreamBots ? (
                      <Text style={{ fontFamily: F.regular, fontSize: 13, color: c.mutedForeground, marginTop: 2 }}>
                        {upstreamBots.map((b) => b.name).join(', ') || 'None available'}
                      </Text>
                    ) : null}
                  </View>
                  <Feather name="refresh-cw" size={18} color={c.mutedForeground} />
                </Pressable>
              ) : null}
            </Card>
          </>
        ) : null}

        <Eyebrow style={{ marginTop: 26, marginBottom: 10 }}>Privacy & data</Eyebrow>
        <Card>
          <Text style={{ fontFamily: F.regular, fontSize: 14, lineHeight: 21, color: c.foreground }}>
            Local preview replies are scripted and no chat is sent to Me Home. When connected, messages go directly to your paired home service; there is no cloud-model fallback. The home owns authoritative history; this app keeps a local cache copy that is not encrypted.
          </Text>
        </Card>

        <View style={{ marginTop: 12 }}>
          <Button
            testID="replay-onboarding"
            variant="ghost"
            icon="rotate-ccw"
            label="Replay setup guide"
            onPress={() => router.push('../onboarding')}
          />
        </View>

        <View style={{ marginTop: 22 }}>
          <Button
            testID="reset-demo"
            variant="danger"
            icon="rotate-ccw"
            label="Reset app data"
            onPress={() => ask('Reset app data?', 'Profiles, conversations, likes, saves and settings return to their starting values.', 'Reset', () => { void resetDemo(); })}
          />
        </View>
      </View>
    </KeyboardAwareScrollViewCompat>
  );
}

function ProfileForm({ initial, onDone, onCreate }: { initial?: Profile; onDone: () => void; onCreate?: (p: Omit<Profile, 'id'>) => void }) {
  const c = useColors();
  const { updateProfile, removeProfile, profiles } = useMe();
  const [name, setName] = useState(initial?.name ?? '');
  const [role, setRole] = useState<Role>(initial?.role ?? 'adult');
  const valid = name.trim().length > 0;
  const save = () => {
    if (!valid) return;
    if (initial) updateProfile(initial.id, { name: name.trim(), role });
    else onCreate?.({ name: name.trim(), role });
    onDone();
  };
  return (
    <View style={{ paddingVertical: 14, gap: 12 }}>
      <TextInput
        testID="profile-name"
        value={name}
        onChangeText={setName}
        placeholder="Name"
        placeholderTextColor={c.mutedForeground}
        autoFocus
        style={[st.input, { borderColor: valid || !name ? c.input : c.destructive, color: c.foreground, backgroundColor: c.background }]}
      />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {ROLES.map((r) => (
          <Pressable key={r} onPress={() => setRole(r)} style={[st.chip, { borderColor: role === r ? c.accent : c.input, backgroundColor: role === r ? c.accentSoft : 'transparent' }]}>
            <Text style={{ fontFamily: F.medium, fontSize: 13, color: c.foreground }}>{roleLabel(r)}</Text>
          </Pressable>
        ))}
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <View style={{ flex: 1 }}><Button label="Save" icon="check" onPress={save} disabled={!valid} /></View>
        <View style={{ flex: 1 }}><Button label="Cancel" variant="ghost" onPress={onDone} /></View>
      </View>
      {initial && profiles.length > 1 ? (
        <Pressable
          onPress={() => ask('Remove this person?', 'Their conversations will be deleted too.', 'Remove', () => { removeProfile(initial.id); onDone(); })}
          style={{ alignSelf: 'center', padding: 4 }}
        >
          <Text style={{ fontFamily: F.medium, fontSize: 13, color: c.destructive }}>Remove from household</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const st = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  input: { height: 44, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, fontFamily: F.regular, fontSize: 15 },
  chip: { flex: 1, alignItems: 'center', borderWidth: 1, borderRadius: 999, paddingVertical: 8 },
});
