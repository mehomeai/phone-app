import { Feather } from '@expo/vector-icons';
import { VideoView, useVideoPlayer } from 'expo-video';
import { LinearGradient } from 'expo-linear-gradient';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, FlatList, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type { ListRenderItemInfo } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, Eyebrow, F, Hydrated, tap, useTopInset } from '@/components/ui';
import { useMe } from '@/context/MeContext';
import { useColors } from '@/hooks/useColors';
import { rankFeed, TOPICS } from '@/lib/data';
import type { FeedItem } from '@/lib/types';

const MIX_STEPS = [0, 25, 50, 75, 100];
const DESCRIPTION_PREVIEW_LENGTH = 90;
const FEED_LOAD_TIMEOUT_MS = 15_000;
const FEED_STREAM_STALL_TIMEOUT_MS = 10_000;
const mixLabel = (v: number) => (v < 20 ? 'Wander widely' : v < 45 ? 'Mostly exploring' : v < 70 ? 'Balanced' : v < 90 ? 'Mostly my topics' : 'Only my topics first');

export default function FeedScreen() {
  return (
    <Hydrated>
      <Feed />
    </Hydrated>
  );
}

function Feed() {
  const c = useColors();
  const top = useTopInset();
  const { settings } = useMe();
  const [h, setH] = useState(0);
  const [open, setOpen] = useState(false);
  const [screenFocused, setScreenFocused] = useState(false);
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  const items = useMemo(() => rankFeed(settings.topics, settings.learningMix), [settings.topics, settings.learningMix]);
  const orderKey = items.map((i) => i.id).join('|');
  const orderKeyRef = useRef(orderKey);
  orderKeyRef.current = orderKey;
  const [activePosition, setActivePosition] = useState({ orderKey, index: 0 });
  const activeIndex = activePosition.orderKey === orderKey ? activePosition.index : 0;
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 70 }).current;
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: Array<{ index?: number | null; isViewable: boolean }> }) => {
    const visible = viewableItems.find((viewable) => viewable.isViewable && viewable.index !== null);
    if (visible?.index !== null && visible?.index !== undefined) {
      setActivePosition({ orderKey: orderKeyRef.current, index: visible.index });
    }
  }).current;

  useFocusEffect(useCallback(() => {
    setScreenFocused(true);
    return () => setScreenFocused(false);
  }, []));

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => setAppActive(state === 'active'));
    return () => subscription.remove();
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: c.primary }} onLayout={(e) => setH(e.nativeEvent.layout.height)}>
      {h > 0 ? (
        <FlatList<FeedItem>
          key={orderKey}
          data={items}
          keyExtractor={(i) => i.id}
          pagingEnabled
          snapToInterval={h}
          decelerationRate="fast"
          showsVerticalScrollIndicator={false}
          scrollEnabled={items.length > 0}
          initialNumToRender={1}
          maxToRenderPerBatch={2}
          windowSize={3}
          viewabilityConfig={viewabilityConfig}
          onViewableItemsChanged={onViewableItemsChanged}
          getItemLayout={(_, i) => ({ length: h, offset: h * i, index: i })}
          renderItem={({ item, index }: ListRenderItemInfo<FeedItem>) => (
            <Reel
              item={item}
              height={h}
              isActive={index === activeIndex && screenFocused && appActive}
            />
          )}
        />
      ) : null}
      <View style={[st.topBar, { top: top + 8 }]} pointerEvents="box-none">
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <Pressable
            testID="feed-controls"
            accessibilityRole="button"
            accessibilityLabel="Open feed controls"
            accessibilityHint="Choose learning mix and topics for your feed"
            accessibilityState={{ expanded: open }}
            hitSlop={10}
            onPress={() => { tap(); setOpen(true); }}
          >
            <Feather name="sliders" size={22} color={c.onImage} />
          </Pressable>
        </View>
      </View>
      <Controls visible={open} onClose={() => setOpen(false)} />
    </View>
  );
}

function Reel({ item, height, isActive }: { item: FeedItem; height: number; isActive: boolean }) {
  const c = useColors();
  const { liked, saved, toggleLike, toggleSave } = useMe();
  const player = useVideoPlayer(isActive ? item.video : null, (videoPlayer) => {
    videoPlayer.loop = true;
    videoPlayer.muted = true;
    videoPlayer.staysActiveInBackground = false;
  });
  const webVideoRef = useRef<HTMLVideoElement | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [playerError, setPlayerError] = useState('');
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [showDescription, setShowDescription] = useState(false);
  const streamStallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasPlayedRef = useRef(false);
  const isLiked = liked.includes(item.id);
  const isSaved = saved.includes(item.id);
  const descriptionPreview = item.body.length > DESCRIPTION_PREVIEW_LENGTH
    ? `${item.body.slice(0, DESCRIPTION_PREVIEW_LENGTH).trimEnd()}…`
    : item.body;

  // Stream-stall recovery (Nov 4 port): once a clip has actually
  // played, a stall that lasts FEED_STREAM_STALL_TIMEOUT_MS becomes a
  // retryable interrupted-stream error instead of a silent freeze.
  const clearStreamStallTimer = useCallback(() => {
    if (streamStallTimerRef.current) {
      clearTimeout(streamStallTimerRef.current);
      streamStallTimerRef.current = null;
    }
  }, []);
  const markStreamInterrupted = useCallback(() => {
    clearStreamStallTimer();
    setPlayerError('This video stream was interrupted. Try again.');
    setLoadState('error');
    setIsPlaying(false);
  }, [clearStreamStallTimer]);
  const startStreamStallTimer = useCallback(() => {
    if (!isActive) return;
    clearStreamStallTimer();
    streamStallTimerRef.current = setTimeout(markStreamInterrupted, FEED_STREAM_STALL_TIMEOUT_MS);
  }, [clearStreamStallTimer, isActive, markStreamInterrupted]);
  const handleWebStreamStall = useCallback((event: React.SyntheticEvent<HTMLVideoElement>) => {
    if (!isActive || !hasPlayedRef.current || event.currentTarget.paused) return;
    startStreamStallTimer();
  }, [isActive, startStreamStallTimer]);
  const handleWebPlaybackResume = useCallback(() => {
    hasPlayedRef.current = true;
    clearStreamStallTimer();
    setLoadState('ready');
    setPlayerError('');
    setIsPlaying(true);
  }, [clearStreamStallTimer]);

  useEffect(() => () => clearStreamStallTimer(), [clearStreamStallTimer]);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    const updateLoadState = (status: typeof player.status, errorMessage?: string) => {
      if (status === 'loading') {
        if (hasPlayedRef.current) {
          startStreamStallTimer();
          return;
        }
        setLoadState('loading');
      }
      if (status === 'readyToPlay') {
        clearStreamStallTimer();
        setLoadState('ready');
        setPlayerError('');
      }
      if (status === 'error') {
        clearStreamStallTimer();
        setLoadState('error');
        setPlayerError(errorMessage ?? '');
        setIsPlaying(false);
      }
    };
    const statusSubscription = player.addListener('statusChange', ({ status, error }) => updateLoadState(status, error?.message));
    const playingSubscription = player.addListener('playingChange', ({ isPlaying: playing }) => {
      if (playing) {
        hasPlayedRef.current = true;
        clearStreamStallTimer();
      }
      setIsPlaying(playing);
    });
    updateLoadState(player.status);
    return () => {
      statusSubscription.remove();
      playingSubscription.remove();
      clearStreamStallTimer();
    };
  }, [clearStreamStallTimer, player, startStreamStallTimer]);

  // Bounded load (ported from the Replit Nov 3 hardening): a clip that
  // never finishes loading surfaces a timed retry state instead of
  // spinning forever.
  useEffect(() => {
    if (!isActive || loadState !== 'loading') return;
    const timeout = setTimeout(() => {
      setPlayerError('This clip took too long to load. Try again.');
      setLoadState('error');
      setIsPlaying(false);
    }, FEED_LOAD_TIMEOUT_MS);
    return () => clearTimeout(timeout);
  }, [isActive, item.id, loadState]);

  useEffect(() => {
    const webVideo = webVideoRef.current;
    if (loadState === 'ready' && isActive) {
      if (Platform.OS === 'web') {
        webVideo?.play().catch((error: unknown) => {
          setPlayerError(error instanceof Error ? error.message : '');
        });
      } else {
        player.play();
      }
    } else {
      if (Platform.OS === 'web') webVideo?.pause();
      else player.pause();
      setIsPlaying(false);
    }
  }, [isActive, loadState, player]);

  const retry = () => {
    clearStreamStallTimer();
    hasPlayedRef.current = false;
    setLoadState('loading');
    setPlayerError('');
    if (Platform.OS === 'web') {
      const video = webVideoRef.current;
      if (video) {
        video.src = item.video;
        video.load();
      }
    } else {
      player.replace(item.video);
    }
  };

  const togglePlayback = () => {
    if (loadState !== 'ready') return;
    tap();
    if (Platform.OS === 'web') {
      const video = webVideoRef.current;
      if (video?.paused) video.play().catch(() => setLoadState('error'));
      else video?.pause();
    } else if (player.playing) player.pause();
    else player.play();
  };

  const toggleMute = () => {
    tap();
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    if (Platform.OS === 'web') {
      if (webVideoRef.current) webVideoRef.current.muted = nextMuted;
    } else {
      player.muted = nextMuted;
    }
  };

  return (
    <View style={{ height }}>
      <View style={[StyleSheet.absoluteFill, { backgroundColor: c.primary }]} />
      {Platform.OS === 'web' ? React.createElement('video', {
        ref: webVideoRef,
        src: isActive ? item.video : undefined,
        muted: isMuted,
        loop: true,
        playsInline: true,
        preload: isActive ? 'auto' : 'none',
        style: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, width: '100%', height: '100%', objectFit: 'cover' },
        onCanPlay: () => {
          clearStreamStallTimer();
          setLoadState('ready');
          setPlayerError('');
        },
        onPlay: handleWebPlaybackResume,
        onPlaying: handleWebPlaybackResume,
        onWaiting: handleWebStreamStall,
        onStalled: handleWebStreamStall,
        onPause: () => setIsPlaying(false),
        onError: (event: React.SyntheticEvent<HTMLVideoElement>) => {
          clearStreamStallTimer();
          setLoadState('error');
          setPlayerError(event.currentTarget.error?.message ?? '');
        },
      }) : (
        <VideoView
          player={player}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          nativeControls={false}
          playsInline
          surfaceType={Platform.OS === 'android' ? 'textureView' : 'surfaceView'}
        />
      )}
      <LinearGradient colors={['rgba(23,25,28,0.55)', 'transparent', 'rgba(23,25,28,0.85)']} locations={[0, 0.35, 1]} style={StyleSheet.absoluteFill} />
      <Pressable
        testID={`video-surface-${item.id}`}
        accessibilityRole="button"
        accessibilityLabel={isPlaying ? 'Pause clip' : 'Play clip'}
        accessibilityHint="Double tap to toggle video playback"
        accessibilityState={{ disabled: loadState !== 'ready' }}
        disabled={loadState !== 'ready'}
        onPress={togglePlayback}
        style={StyleSheet.absoluteFill}
      />
      {loadState === 'loading' ? (
        <View style={st.playerState} pointerEvents="none">
          <ActivityIndicator size="large" color={c.onImage} />
          <Text style={[st.playerStateText, { color: c.onImage }]}>Loading clip…</Text>
        </View>
      ) : null}
      {loadState === 'error' ? (
        <View pointerEvents="box-none" style={st.playerState}>
          <Feather name="film" size={26} color={c.onImage} />
          <Text style={[st.playerStateText, { color: c.onImage }]}>This clip could not load.</Text>
          {playerError ? <Text style={[st.playerError, { color: c.onImage }]}>{playerError}</Text> : null}
          <Pressable testID={`retry-${item.id}`} accessibilityRole="button" accessibilityLabel="Retry loading clip" onPress={retry} style={st.retry}>
            <Feather name="rotate-cw" size={15} color={c.onImage} />
            <Text style={[st.actionLabel, { color: c.onImage }]}>Try again</Text>
          </Pressable>
        </View>
      ) : null}
      <View style={st.side}>
        <Pressable testID={`sound-${item.id}`} accessibilityRole="button" accessibilityLabel={isMuted ? 'Turn sound on' : 'Mute clip'} onPress={toggleMute} style={st.action}>
          <Feather name={isMuted ? 'volume-x' : 'volume-2'} size={24} color={c.onImage} />
        </Pressable>
        <Pressable testID={`like-${item.id}`} accessibilityRole="checkbox" accessibilityLabel={isLiked ? 'Remove like' : 'Like clip'} accessibilityState={{ checked: isLiked }} aria-checked={isLiked} onPress={() => { tap(); toggleLike(item.id); }} style={st.action}>
          <Feather name="heart" size={26} color={isLiked ? c.accentSoft : c.onImage} />
        </Pressable>
        <Pressable testID={`save-${item.id}`} accessibilityRole="checkbox" accessibilityLabel={isSaved ? 'Remove saved clip' : 'Save clip'} accessibilityState={{ checked: isSaved }} aria-checked={isSaved} onPress={() => { tap(); toggleSave(item.id); }} style={st.action}>
          <Feather name="bookmark" size={26} color={isSaved ? c.accentSoft : c.onImage} />
        </Pressable>
      </View>
      <View style={st.caption} pointerEvents="box-none">
        <Pressable
          testID={`title-${item.id}`}
          accessibilityRole="button"
          accessibilityLabel={item.title}
          accessibilityHint={showDescription ? 'Hide description' : 'Show description'}
          accessibilityState={{ expanded: showDescription }}
          onPress={() => { tap(); setShowDescription((visible) => !visible); }}
          style={st.titleButton}
        >
          <Text style={{ fontFamily: F.medium, fontSize: 26, lineHeight: 30, letterSpacing: -0.8, color: c.onImage }}>{item.title}</Text>
        </Pressable>
        <Text testID={`description-${item.id}`} style={{ fontFamily: F.regular, fontSize: 15, lineHeight: 21, color: c.onImage, opacity: 0.85, marginTop: 8 }}>
          {showDescription ? item.body : descriptionPreview}
        </Text>
      </View>
    </View>
  );
}

function Controls({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { settings, updateSettings } = useMe();
  const toggleTopic = (t: string) => {
    tap();
    const has = settings.topics.includes(t);
    updateSettings({ topics: has ? settings.topics.filter((x) => x !== t) : [...settings.topics, t] });
  };
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: c.overlay }]} onPress={onClose} />
      <View style={[st.sheet, { backgroundColor: c.background, paddingBottom: insets.bottom + 24 }]}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={{ fontFamily: F.medium, fontSize: 22, letterSpacing: -0.6, color: c.foreground }}>You set the algorithm</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Close feed controls" onPress={onClose} hitSlop={10} testID="close-controls"><Feather name="x" size={22} color={c.foreground} /></Pressable>
        </View>
        <Text style={{ fontFamily: F.regular, fontSize: 14, color: c.mutedForeground, marginTop: 6 }}>
          Ordered by your goals, not by time spent. Changes reorder the feed and are saved on this device.
        </Text>

        <Eyebrow style={{ marginTop: 22 }}>Learning mix</Eyebrow>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}>
          <Text style={[st.small, { color: c.mutedForeground }]}>Explore</Text><Text style={[st.small, { color: c.foreground }]}>{mixLabel(settings.learningMix)}</Text><Text style={[st.small, { color: c.mutedForeground }]}>Focus</Text>
        </View>
        <View accessibilityRole="radiogroup" accessibilityLabel="Learning mix" style={{ flexDirection: 'row', gap: 6, marginTop: 10 }}>
          {MIX_STEPS.map((v) => {
            const selected = settings.learningMix === v;
            const on = settings.learningMix >= v - 12;
            return (
              <Pressable
                key={v}
                testID={`mix-${v}`}
                accessibilityRole="radio"
                accessibilityLabel={`${mixLabel(v)}, ${v}% toward focus`}
                accessibilityState={{ checked: selected }}
                aria-checked={selected}
                onPress={() => { tap(); updateSettings({ learningMix: v }); }}
                style={[st.step, { backgroundColor: on ? c.accent : c.muted }]}
              />
            );
          })}
        </View>

        <Eyebrow style={{ marginTop: 24 }}>Topics I am working on</Eyebrow>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
          {TOPICS.map((t) => {
            const on = settings.topics.includes(t);
            return (
              <Pressable key={t} testID={`topic-${t}`} accessibilityRole="checkbox" accessibilityLabel={t} accessibilityState={{ checked: on }} aria-checked={on} onPress={() => toggleTopic(t)} style={[st.chip, { borderColor: on ? c.accent : c.input, backgroundColor: on ? c.accentSoft : 'transparent' }]}>
                {on ? <Feather name="check" size={13} color={c.accent} /> : null}
                <Text style={{ fontFamily: F.medium, fontSize: 14, color: c.foreground }}>{t}</Text>
              </Pressable>
            );
          })}
        </View>
        <View style={{ marginTop: 24 }}>
          <Button label="Show my feed" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

const st = StyleSheet.create({
  topBar: { position: 'absolute', left: 20, right: 20, flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center' },
  side: { position: 'absolute', right: 14, bottom: 208, gap: 18, alignItems: 'center', zIndex: 3 },
  action: { alignItems: 'center', gap: 4 },
  actionLabel: { fontFamily: F.medium, fontSize: 11 },
  caption: { position: 'absolute', left: 20, right: 84, bottom: 104, zIndex: 3 },
  titleButton: { alignSelf: 'flex-start', maxWidth: '100%', paddingVertical: 4 },
  playerState: { ...StyleSheet.absoluteFill, zIndex: 2, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 28 },
  playerStateText: { fontFamily: F.medium, fontSize: 14, textAlign: 'center' },
  playerError: { fontFamily: F.regular, fontSize: 12, opacity: 0.75, textAlign: 'center' },
  retry: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10 },
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 22 },
  small: { fontFamily: F.regular, fontSize: 12 },
  step: { flex: 1, height: 28, borderRadius: 6 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
});
