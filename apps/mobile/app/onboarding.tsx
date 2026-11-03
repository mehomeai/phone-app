import { Feather } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Avatar, Button, Card, F, tap } from '@/components/ui';
import { useMe } from '@/context/MeContext';
import { useColors } from '@/hooks/useColors';
import { roleLabel } from '@/lib/data';
import type { Profile } from '@/lib/types';

const TOTAL_STEPS = 4;
const mixLabel = (value: number) => (value < 20 ? 'Wander widely' : value < 45 ? 'Mostly exploring' : value < 70 ? 'Balanced' : value < 90 ? 'Mostly my topics' : 'Only my topics first');

export default function OnboardingScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { profiles, activeProfile, settings, setActiveProfile, setOnboardingCompleted } = useMe();
  const [step, setStep] = useState(0);
  const [pairingDemo, setPairingDemo] = useState<'idle' | 'running' | 'done'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const topInset = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;
  const bottomInset = Platform.OS === 'web' ? Math.max(insets.bottom, 34) : insets.bottom;

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const close = () => {
    setOnboardingCompleted(true);
    router.back();
  };

  const runPairingDemo = () => {
    if (timer.current) clearTimeout(timer.current);
    tap();
    setPairingDemo('running');
    timer.current = setTimeout(() => setPairingDemo('done'), 1100);
  };

  const goForward = () => {
    if (step === TOTAL_STEPS - 1) {
      close();
      return;
    }
    tap();
    setStep((current) => Math.min(current + 1, TOTAL_STEPS - 1));
  };

  return (
    <View style={[st.screen, { backgroundColor: c.background, paddingTop: topInset + 8 }]}>
      <View style={st.topBar}>
        <View style={st.brand}>
          <View style={[st.mark, { backgroundColor: c.accentSoft }]}>
            <Feather name="circle" size={17} color={c.accent} />
          </View>
          <Text style={{ fontFamily: F.medium, fontSize: 15, color: c.foreground }}>Me setup</Text>
        </View>
        <Pressable
          testID="skip-onboarding"
          accessibilityRole="button"
          onPress={close}
          hitSlop={10}
          style={st.skip}
        >
          <Text style={{ fontFamily: F.medium, fontSize: 14, color: c.mutedForeground }}>Skip</Text>
        </Pressable>
      </View>

      <View style={st.progressRow} accessibilityLabel={`Step ${step + 1} of ${TOTAL_STEPS}`}>
        {Array.from({ length: TOTAL_STEPS }, (_, index) => (
          <View
            key={index}
            style={[st.progress, { backgroundColor: index <= step ? c.accent : c.border }]}
          />
        ))}
      </View>

      <ScrollView
        style={st.scroll}
        contentContainerStyle={[st.content, { paddingBottom: 24 }]}
        showsVerticalScrollIndicator={false}
      >
        <Text style={{ fontFamily: F.mono, fontSize: 11, letterSpacing: 1.2, color: c.accent }}>
          STEP {step + 1} OF {TOTAL_STEPS}
        </Text>

        {step === 0 ? (
          <ProfileStep profiles={profiles} activeId={activeProfile.id} onSelect={setActiveProfile} />
        ) : step === 1 ? (
          <InfoStep
            icon="message-circle"
            title="A personal chat, on your terms"
            body="Local preview conversations are saved in this app’s storage on this device. That storage is not encrypted. Replies are scripted; no AI model or server processes them. Please use fictional details."
          >
            <Card style={{ marginTop: 22 }}>
              <View style={st.inline}>
                <Feather name="lock" size={18} color={c.accent} />
                <Text style={{ fontFamily: F.medium, fontSize: 14, color: c.foreground, flex: 1 }}>Local preview data · unencrypted</Text>
              </View>
            </Card>
          </InfoStep>
        ) : step === 2 ? (
          <InfoStep
            icon="sliders"
            title="Shape what appears in your feed"
            body="Use the controls on Feed to balance exploring new subjects with focusing on your chosen topics. Your settings decide which clips appear first."
          >
            <Card style={{ marginTop: 22 }}>
              <View style={st.inline}>
                <Text style={{ fontFamily: F.regular, fontSize: 13, color: c.mutedForeground }}>Your mix</Text>
                <Text style={{ fontFamily: F.medium, fontSize: 13, color: c.foreground, marginLeft: 'auto' }}>{mixLabel(settings.learningMix)}</Text>
              </View>
              <View style={[st.mixTrack, { backgroundColor: c.muted }]}>
                <View style={[st.mixFill, { width: `${settings.learningMix}%`, backgroundColor: c.accent }]} />
              </View>
              <View style={[st.inline, { justifyContent: 'space-between', marginTop: 12 }]}>
                <Text style={{ fontFamily: F.regular, fontSize: 12, color: c.mutedForeground }}>Explore</Text>
                <Text style={{ fontFamily: F.regular, fontSize: 12, color: c.mutedForeground }}>Focus</Text>
              </View>
              {settings.topics.length ? (
                <View style={[st.inline, { flexWrap: 'wrap', marginTop: 14 }]}>
                  {settings.topics.map((topic) => (
                    <View key={topic} style={[st.topic, { backgroundColor: c.accentSoft }]}>
                      <Text style={{ fontFamily: F.medium, fontSize: 12, color: c.accent }}>{topic}</Text>
                    </View>
                  ))}
                </View>
              ) : null}
            </Card>
          </InfoStep>
        ) : (
          <InfoStep
            icon="hard-drive"
            title="Connect your Me Home"
            body="Me Home runs your assistant on your home computer. Pair this phone with a one-time invitation in Me → Me Home; the device credential stays in secure storage. The walkthrough below is a clearly labeled simulation; it does not contact a device."
          >
            <View style={[st.imageWrap, { borderColor: c.border }]}>
              <Image
                source={require('@/assets/images/me-home-room.jpg')}
                style={StyleSheet.absoluteFill}
                contentFit="cover"
                accessibilityLabel="Concept image of a home room with a small computer"
              />
              <View style={st.imageCaption}>
                <Text style={{ fontFamily: F.mono, fontSize: 10, letterSpacing: 1, color: c.onImage }}>CONCEPT · SIMULATED</Text>
              </View>
            </View>
            <Card style={{ marginTop: 14, borderColor: c.accent }}>
              <View style={st.inline}>
                <Feather name={pairingDemo === 'done' ? 'check-circle' : 'info'} size={18} color={c.accent} />
                <Text style={{ fontFamily: F.medium, fontSize: 14, lineHeight: 20, color: c.foreground, flex: 1 }}>
                  {pairingDemo === 'done'
                    ? 'Walkthrough complete. No device was scanned or connected.'
                    : pairingDemo === 'running'
                      ? 'Pair request simulated… no hardware is being contacted.'
                      : 'This walkthrough is simulated. No hardware is scanned or contacted.'}
                </Text>
              </View>
              {pairingDemo !== 'done' ? (
                <View style={{ marginTop: 14 }}>
                  <Button
                    testID="play-pairing-walkthrough"
                    variant="accent"
                    icon="link"
                    label={pairingDemo === 'running' ? 'Running walkthrough…' : 'Play pairing walkthrough'}
                    disabled={pairingDemo === 'running'}
                    onPress={runPairingDemo}
                  />
                </View>
              ) : null}
            </Card>
          </InfoStep>
        )}
      </ScrollView>

      <View style={[st.footer, { paddingBottom: bottomInset + 12, borderTopColor: c.border, backgroundColor: c.background }]}>
        {step > 0 ? (
          <Pressable
            testID="onboarding-back"
            accessibilityRole="button"
            onPress={() => { tap(); setStep((current) => Math.max(current - 1, 0)); }}
            style={st.backButton}
          >
            <Feather name="arrow-left" size={18} color={c.foreground} />
          </Pressable>
        ) : null}
        <View style={{ flex: 1 }}>
          <Button
            testID={step === TOTAL_STEPS - 1 ? 'finish-onboarding' : 'onboarding-next'}
            variant="primary"
            icon={step === TOTAL_STEPS - 1 ? 'check' : 'arrow-right'}
            label={step === TOTAL_STEPS - 1 ? 'Finish setup' : step === 0 ? 'Continue' : 'Next'}
            onPress={goForward}
          />
        </View>
      </View>
    </View>
  );
}

function ProfileStep({ profiles, activeId, onSelect }: { profiles: Profile[]; activeId: string; onSelect: (id: string) => void }) {
  const c = useColors();
  return (
    <>
      <Text style={[st.title, { color: c.foreground }]}>Choose a profile for this phone</Text>
      <Text style={[st.description, { color: c.mutedForeground }]}>
        Me uses the profile selected on this phone. You can change it later in Me settings.
      </Text>
      <Card style={{ marginTop: 22, paddingVertical: 4 }}>
        {profiles.map((profile, index) => {
          const selected = profile.id === activeId;
          return (
            <Pressable
              key={profile.id}
              testID={`onboarding-profile-${profile.id}`}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={`${profile.name}, ${roleLabel(profile.role)}`}
              onPress={() => { tap(); onSelect(profile.id); }}
              style={[st.profileRow, index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border }]}
            >
              <Avatar name={profile.name} size={40} active={selected} />
              <View style={{ flex: 1 }}>
                <Text style={{ fontFamily: F.medium, fontSize: 15, color: c.foreground }}>{profile.name}</Text>
                <Text style={{ fontFamily: F.mono, fontSize: 10, color: c.mutedForeground, marginTop: 3 }}>{roleLabel(profile.role).toUpperCase()}</Text>
              </View>
              <View style={[st.radio, { borderColor: selected ? c.accent : c.input }]}>
                {selected ? <View style={[st.radioDot, { backgroundColor: c.accent }]} /> : null}
              </View>
            </Pressable>
          );
        })}
      </Card>
    </>
  );
}

function InfoStep({ icon, title, body, children }: { icon: keyof typeof Feather.glyphMap; title: string; body: string; children: React.ReactNode }) {
  const c = useColors();
  return (
    <>
      <View style={[st.heroIcon, { backgroundColor: c.accentSoft }]}>
        <Feather name={icon} size={28} color={c.accent} />
      </View>
      <Text style={[st.title, { color: c.foreground }]}>{title}</Text>
      <Text style={[st.description, { color: c.mutedForeground }]}>{body}</Text>
      {children}
    </>
  );
}

const st = StyleSheet.create({
  screen: { flex: 1 },
  topBar: { paddingHorizontal: 20, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  mark: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  skip: { paddingVertical: 8, paddingHorizontal: 4 },
  progressRow: { flexDirection: 'row', gap: 6, paddingHorizontal: 20, marginTop: 12, marginBottom: 8 },
  progress: { height: 3, flex: 1, borderRadius: 2 },
  scroll: { flex: 1 },
  content: { flexGrow: 1, paddingHorizontal: 20, paddingTop: 20 },
  heroIcon: { width: 66, height: 66, borderRadius: 22, alignItems: 'center', justifyContent: 'center', marginTop: 24, marginBottom: 22 },
  title: { fontFamily: F.medium, fontSize: 29, letterSpacing: -0.9, lineHeight: 34, marginTop: 22 },
  description: { fontFamily: F.regular, fontSize: 15, lineHeight: 23, marginTop: 10 },
  profileRow: { minHeight: 68, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  radio: { width: 21, height: 21, borderRadius: 11, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  radioDot: { width: 11, height: 11, borderRadius: 6 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  mixTrack: { height: 7, borderRadius: 4, overflow: 'hidden', marginTop: 12 },
  mixFill: { height: '100%', borderRadius: 4 },
  topic: { borderRadius: 999, paddingVertical: 6, paddingHorizontal: 10 },
  imageWrap: { height: 150, overflow: 'hidden', borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, marginTop: 22 },
  imageCaption: { position: 'absolute', left: 10, bottom: 10, backgroundColor: 'rgba(23,25,28,0.65)', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 5 },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
  backButton: { width: 46, height: 46, alignItems: 'center', justifyContent: 'center', borderRadius: 10 },
});
