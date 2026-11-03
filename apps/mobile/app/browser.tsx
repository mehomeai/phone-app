import { Feather } from '@expo/vector-icons';
import * as WebBrowser from 'expo-web-browser';
import { router } from 'expo-router';
import React, { useState } from 'react';
import { Alert, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { F, tap, useTopInset } from '@/components/ui';
import { useColors } from '@/hooks/useColors';

const quickSites = [
  { name: 'Wikipedia', domain: 'wikipedia.org', icon: 'book-open', url: 'https://www.wikipedia.org' },
  { name: 'NASA', domain: 'nasa.gov', icon: 'globe', url: 'https://www.nasa.gov' },
  { name: 'DuckDuckGo', domain: 'duckduckgo.com', icon: 'search', url: 'https://duckduckgo.com' },
  { name: 'YouTube', domain: 'youtube.com', icon: 'play-circle', url: 'https://www.youtube.com' },
] as const;

export default function BrowserScreen() {
  const c = useColors();
  const top = useTopInset();
  const [address, setAddress] = useState('');
  const [opening, setOpening] = useState(false);

  const openSite = async (input = address) => {
    const value = input.trim();
    if (!value || opening) return;
    const target = /^https?:\/\//i.test(value)
      ? value
      : !/\s/.test(value) && value.includes('.')
        ? `https://${value}`
        : `https://duckduckgo.com/?q=${encodeURIComponent(value)}`;
    try {
      setOpening(true);
      await WebBrowser.openBrowserAsync(target);
    } catch {
      Alert.alert('Could not open page', 'Check the address and try again.');
    } finally {
      setOpening(false);
    }
  };

  return (
    <KeyboardAvoidingView style={[st.page, { backgroundColor: c.background }]} behavior="padding" keyboardVerticalOffset={0}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingTop: top + 10, paddingBottom: 32 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={st.header}>
          <Pressable
            testID="browser-back"
            accessibilityRole="button"
            accessibilityLabel="Back"
            onPress={() => { tap(); if (router.canGoBack()) router.back(); else router.replace('/chats'); }}
            style={({ pressed }) => [st.iconButton, { backgroundColor: c.card, borderColor: c.border, opacity: pressed ? 0.65 : 1 }]}
          >
            <Feather name="arrow-left" size={19} color={c.foreground} />
          </Pressable>
          <View style={{ flex: 1 }}>
            <Text style={{ fontFamily: F.medium, fontSize: 23, letterSpacing: -0.6, color: c.foreground }}>Browser</Text>
            <Text style={{ fontFamily: F.regular, fontSize: 12, color: c.mutedForeground, marginTop: 2 }}>Browse when you choose</Text>
          </View>
          <View style={[st.tabCount, { backgroundColor: c.card, borderColor: c.border }]}>
            <Feather name="copy" size={15} color={c.mutedForeground} />
            <Text style={{ fontFamily: F.medium, fontSize: 12, color: c.mutedForeground }}>1</Text>
          </View>
        </View>

        <View style={{ paddingHorizontal: 20 }}>
          <View style={[st.addressBar, { backgroundColor: c.card, borderColor: c.border }]}>
            <Feather name="search" size={17} color={c.mutedForeground} />
            <TextInput
              testID="browser-address"
              accessibilityLabel="Search or enter a website address"
              value={address}
              onChangeText={setAddress}
              onSubmitEditing={() => { void openSite(); }}
              placeholder="Search or enter an address"
              placeholderTextColor={c.mutedForeground}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="go"
              style={{ flex: 1, minWidth: 0, color: c.foreground, fontFamily: F.regular, fontSize: 14, paddingVertical: 0 }}
            />
            <Pressable
              testID="browser-open"
              accessibilityRole="button"
              accessibilityLabel="Open website"
              disabled={!address.trim() || opening}
              onPress={() => { tap(); void openSite(); }}
              style={({ pressed }) => [st.goButton, { backgroundColor: c.accent, opacity: !address.trim() || opening ? 0.45 : pressed ? 0.72 : 1 }]}
            >
              <Feather name={opening ? 'loader' : 'arrow-up-right'} size={17} color={c.accentForeground} />
            </Pressable>
          </View>

          <View style={{ marginTop: 28 }}>
            <Text style={{ fontFamily: F.medium, fontSize: 20, letterSpacing: -0.4, color: c.foreground }}>Where to?</Text>
            <Text style={{ fontFamily: F.regular, fontSize: 14, lineHeight: 20, color: c.mutedForeground, marginTop: 5 }}>
              Enter a site or search, or start with one of these.
            </Text>
          </View>

          <View style={st.sites}>
            {quickSites.map((site) => (
              <Pressable
                key={site.name}
                testID={`browser-site-${site.name.toLowerCase()}`}
                accessibilityRole="button"
                accessibilityLabel={`Open ${site.name}`}
                onPress={() => { tap(); void openSite(site.url); }}
                style={({ pressed }) => [st.siteRow, { backgroundColor: c.card, borderColor: c.border, opacity: pressed ? 0.7 : 1 }]}
              >
                <View style={[st.siteIcon, { backgroundColor: c.accentSoft }]}>
                  <Feather name={site.icon} size={17} color={c.accent} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontFamily: F.medium, fontSize: 14, color: c.foreground }}>{site.name}</Text>
                  <Text style={{ fontFamily: F.regular, fontSize: 12, color: c.mutedForeground, marginTop: 2 }}>{site.domain}</Text>
                </View>
                <Feather name="arrow-up-right" size={16} color={c.mutedForeground} />
              </Pressable>
            ))}
          </View>

          <View style={[st.privacy, { backgroundColor: c.muted }]}>
            <Feather name="external-link" size={15} color={c.mutedForeground} />
            <Text style={{ flex: 1, fontFamily: F.regular, fontSize: 12, lineHeight: 17, color: c.mutedForeground }}>
              Pages open only after you choose them. External sites have their own privacy policies.
            </Text>
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const st = StyleSheet.create({
  page: { flex: 1 },
  header: { paddingHorizontal: 20, paddingBottom: 20, flexDirection: 'row', alignItems: 'center', gap: 12 },
  iconButton: { width: 40, height: 40, borderWidth: 1, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  tabCount: { minWidth: 42, height: 34, borderWidth: 1, borderRadius: 10, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 },
  addressBar: { minHeight: 50, borderWidth: 1, borderRadius: 15, paddingLeft: 14, paddingRight: 6, flexDirection: 'row', alignItems: 'center', gap: 10 },
  goButton: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  sites: { gap: 9, marginTop: 18 },
  siteRow: { minHeight: 66, borderWidth: 1, borderRadius: 13, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 11 },
  siteIcon: { width: 36, height: 36, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  privacy: { marginTop: 18, padding: 12, borderRadius: 12, flexDirection: 'row', alignItems: 'flex-start', gap: 9 },
});
