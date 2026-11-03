import { Feather } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { AppsPanel } from '@/components/AppsPanel';
import { DevicePanel } from '@/components/DevicePanel';
import { OverviewPanel } from '@/components/OverviewPanel';
import { SettingsPanel } from '@/components/SettingsPanel';
import { F, Hydrated, ScreenHeader, tap } from '@/components/ui';
import { useColors } from '@/hooks/useColors';

const modes = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'device', label: 'Me Home', icon: 'hard-drive' },
  { id: 'apps', label: 'Apps', icon: 'grid' },
  { id: 'settings', label: 'Settings', icon: 'sliders' },
] as const;

type Mode = (typeof modes)[number]['id'];
type ConnectorId = string;

export default function MeScreen() {
  return (
    <Hydrated>
      <MeHome />
    </Hydrated>
  );
}

function MeHome() {
  const c = useColors();
  const params = useLocalSearchParams<{ section?: string }>();
  const mode: Mode = modes.some((x) => x.id === params.section) ? (params.section as Mode) : 'home';
  const [addedConnectorIds, setAddedConnectorIds] = useState<ConnectorId[]>([]);
  const select = (id: Mode) => {
    tap();
    router.setParams({ section: id });
  };
  const toggleConnector = (id: ConnectorId) => {
    setAddedConnectorIds((current) => current.includes(id) ? current.filter((x) => x !== id) : [...current, id]);
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScreenHeader eyebrow="Your personal space" title="Me" />
      <View accessibilityRole="tablist" style={[st.segment, { backgroundColor: c.muted, borderColor: c.border }]}>
        {modes.map((item) => {
          const selected = mode === item.id;
          return (
            <Pressable
              key={item.id}
              testID={`me-mode-${item.id}`}
              accessibilityRole="tab"
              accessibilityLabel={item.label}
              accessibilityState={{ selected }}
              onPress={() => select(item.id)}
              style={[st.mode, selected && { backgroundColor: c.card, borderColor: c.border }]}
            >
              <Feather name={item.icon} size={14} color={selected ? c.accent : c.mutedForeground} />
              <Text style={{ fontFamily: F.medium, fontSize: 12, color: selected ? c.foreground : c.mutedForeground }}>{item.label}</Text>
            </Pressable>
          );
        })}
      </View>
      <View style={{ flex: 1 }}>
        {mode === 'home' ? (
          <OverviewPanel onDevice={() => select('device')} onSettings={() => select('settings')} />
        ) : mode === 'device' ? (
          <DevicePanel />
        ) : mode === 'apps' ? (
          <AppsPanel addedIds={addedConnectorIds} onToggle={toggleConnector} />
        ) : (
          <SettingsPanel />
        )}
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  segment: { marginHorizontal: 20, marginBottom: 8, padding: 4, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 4 },
  mode: { flex: 1, minHeight: 40, borderRadius: 9, borderWidth: 1, borderColor: 'transparent', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
});
