import React, { useEffect } from 'react';
import { Platform, StyleSheet, useColorScheme, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { isLiquidGlassAvailable } from 'expo-glass-effect';
import { router, Tabs } from 'expo-router';
import { NativeTabs } from 'expo-router/native-tabs';
import { SymbolView } from 'expo-symbols';
import { useMe } from '@/context/MeContext';

export const unstable_settings = { anchor: 'feed' };

const TABS = [
  { name: 'feed', label: 'Feed', sf: 'play.rectangle', sfOn: 'play.rectangle.fill', icon: 'videocam-outline' as const, iconOn: 'videocam' as const },
  { name: 'chats', label: 'Chat', sf: 'bubble.left.and.bubble.right', sfOn: 'bubble.left.and.bubble.right.fill', icon: 'chatbubbles-outline' as const, iconOn: 'chatbubbles' as const },
  { name: 'me', label: 'Me', sf: 'person.crop.circle', sfOn: 'person.crop.circle.fill', icon: 'person-circle-outline' as const, iconOn: 'person-circle' as const },
];

function NativeTabLayout() {
  return (
    <NativeTabs labelVisibilityMode="unlabeled" backBehavior="initialRoute">
      {TABS.map((t) => (
        <NativeTabs.Trigger key={t.name} name={t.name} accessibilityLabel={t.label}>
          <NativeTabs.Trigger.Icon sf={{ default: t.sf as never, selected: t.sfOn as never }} />
        </NativeTabs.Trigger>
      ))}
    </NativeTabs>
  );
}

function ClassicTabLayout() {
  const colors = useColors();
  const isDark = useColorScheme() === 'dark';
  const isIOS = Platform.OS === 'ios';
  const isWeb = Platform.OS === 'web';
  return (
    <Tabs
      backBehavior="initialRoute"
      screenOptions={{
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.mutedForeground,
        tabBarShowLabel: false,
        tabBarAccessibilityLabel: 'Main navigation',
        headerShown: false,
        tabBarStyle: {
          position: 'absolute',
          backgroundColor: isIOS ? 'transparent' : colors.background,
          borderTopWidth: isWeb ? 1 : 0,
          borderTopColor: colors.border,
          elevation: 0,
          ...(isWeb ? { height: 84 } : {}),
        },
        tabBarBackground: () =>
          isIOS ? (
            <BlurView intensity={100} tint={isDark ? 'dark' : 'light'} style={StyleSheet.absoluteFill} />
          ) : (
            <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.background }]} />
          ),
      }}
    >
      {TABS.map((t) => (
        <Tabs.Screen
          key={t.name}
          name={t.name}
          options={{
            title: t.label,
            tabBarAccessibilityLabel: t.label,
            tabBarIcon: ({ color, focused }) =>
              isIOS ? (
                <SymbolView name={(focused ? t.sfOn : t.sf) as never} tintColor={color as string} size={23} />
              ) : (
                <Ionicons name={focused ? t.iconOn : t.icon} size={23} color={color as string} />
              ),
          }}
        />
      ))}
    </Tabs>
  );
}

export default function TabLayout() {
  const { status, onboardingCompleted } = useMe();

  useEffect(() => {
    if (status === 'ready' && !onboardingCompleted) {
      router.push('../onboarding');
    }
  }, [status, onboardingCompleted]);

  if (isLiquidGlassAvailable()) return <NativeTabLayout />;
  return <ClassicTabLayout />;
}
