import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import React, { ReactNode } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleProp, StyleSheet, Text, TextStyle, View, ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { useMe } from '@/context/MeContext';

export const F = {
  regular: 'Geist_400Regular',
  medium: 'Geist_500Medium',
  semibold: 'Geist_600SemiBold',
  mono: 'GeistMono_400Regular',
  monoMedium: 'GeistMono_500Medium',
};

export const tap = () => {
  if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
};

export function useTopInset() {
  const insets = useSafeAreaInsets();
  return Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;
}

export function MeMark({ size = 28, color }: { size?: number; color?: string }) {
  const c = useColors();
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, borderWidth: Math.max(1.5, size * 0.08), borderColor: color ?? c.foreground, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ width: size * 0.34, height: size * 0.34, borderRadius: size, backgroundColor: c.accent }} />
    </View>
  );
}

export function Eyebrow({ children, color, style }: { children: ReactNode; color?: string; style?: StyleProp<TextStyle> }) {
  const c = useColors();
  return <Text style={[{ fontFamily: F.mono, fontSize: 11, letterSpacing: 1.4, textTransform: 'uppercase', color: color ?? c.accent }, style]}>{children}</Text>;
}

export function ScreenHeader({ eyebrow, title, right }: { eyebrow?: string; title: string; right?: ReactNode }) {
  const c = useColors();
  const top = useTopInset();
  return (
    <View style={{ paddingTop: top + 12, paddingHorizontal: 20, paddingBottom: 12, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }}>
      <View style={{ flex: 1 }}>
        {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
        <Text style={{ fontFamily: F.medium, fontSize: 30, letterSpacing: -1.2, color: c.foreground, marginTop: 4 }}>{title}</Text>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        {right}
      </View>
    </View>
  );
}

export function Card({ children, style, testID }: { children: ReactNode; style?: StyleProp<ViewStyle>; testID?: string }) {
  const c = useColors();
  return <View testID={testID} style={[{ backgroundColor: c.card, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, padding: 16 }, style]}>{children}</View>;
}

export function Button({ label, onPress, variant = 'primary', icon, disabled, testID }: { label: string; onPress: () => void; variant?: 'primary' | 'accent' | 'ghost' | 'danger'; icon?: keyof typeof Feather.glyphMap; disabled?: boolean; testID?: string }) {
  const c = useColors();
  const bg = variant === 'primary' ? c.primary : variant === 'accent' ? c.accent : variant === 'danger' ? c.destructive : 'transparent';
  const fg = variant === 'ghost' ? c.foreground : c.primaryForeground;
  return (
    <Pressable
      testID={testID}
      disabled={disabled}
      onPress={() => { tap(); onPress(); }}
      style={({ pressed }) => [s.btn, { backgroundColor: bg, borderColor: variant === 'ghost' ? c.input : bg, opacity: disabled ? 0.4 : pressed ? 0.75 : 1, transform: [{ scale: pressed ? 0.98 : 1 }] }]}
    >
      {icon ? <Feather name={icon} size={16} color={fg} /> : null}
      <Text style={{ fontFamily: F.medium, fontSize: 15, color: fg }}>{label}</Text>
    </Pressable>
  );
}

export function StatusDot({ on }: { on: boolean }) {
  const c = useColors();
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: on ? c.accent : c.destructive }} />;
}

export function Avatar({ name, size = 40, active }: { name: string; size?: number; active?: boolean }) {
  const c = useColors();
  const init = name.split(' ').map((x) => x[0]).join('').slice(0, 2).toUpperCase();
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: active ? c.accent : c.muted, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ fontFamily: F.semibold, fontSize: size * 0.36, color: active ? c.accentForeground : c.foreground }}>{init}</Text>
    </View>
  );
}

/** Wraps a screen so it shows hydration / storage-error states instead of seeded data. */
export function Hydrated({ children }: { children: ReactNode }) {
  const c = useColors();
  const { status, retry, saveError } = useMe();
  if (status === 'loading') {
    return (
      <View style={[s.center, { backgroundColor: c.background }]}>
        <MeMark size={44} />
        <ActivityIndicator color={c.accent} style={{ marginTop: 20 }} />
      </View>
    );
  }
  if (status === 'error') {
    return (
      <View style={[s.center, { backgroundColor: c.background, padding: 32 }]}>
        <Feather name="alert-circle" size={28} color={c.destructive} />
        <Text style={{ fontFamily: F.medium, fontSize: 18, color: c.foreground, marginTop: 12 }}>Could not read local data</Text>
        <Text style={{ fontFamily: F.regular, fontSize: 14, color: c.mutedForeground, textAlign: 'center', marginVertical: 12 }}>Local storage on this device did not respond. Nothing has been overwritten.</Text>
        <Button label="Try again" icon="refresh-cw" onPress={retry} />
      </View>
    );
  }
  return (
    <View style={{ flex: 1 }}>
      {children}
      {saveError ? (
        <View style={[s.toast, { backgroundColor: c.destructive }]}>
          <Text style={{ fontFamily: F.medium, color: c.destructiveForeground, fontSize: 13 }}>Changes could not be saved on this device.</Text>
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 18, height: 46, borderRadius: 10, borderWidth: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  toast: { position: 'absolute', top: 60, left: 20, right: 20, padding: 12, borderRadius: 10 },
});
