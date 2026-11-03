import { Image } from 'expo-image';
import React, { useEffect, useRef, useState } from 'react';
import { AppState, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Button, Card, F, StatusDot } from '@/components/ui';
import { useMe } from '@/context/MeContext';
import { useColors } from '@/hooks/useColors';
import { copyTextToClipboard } from '@/lib/clipboard';
import {
  EphemeralRequestGuard,
  activationScopeFingerprint,
  isActivationTicketExpired,
  shouldPublishCopyFeedback,
  shouldPublishTicketArrival,
  UNKNOWN_TICKET_OUTCOME_MESSAGE,
} from '@/lib/home-client';
import type { ActivationHandoff, ActivationTicket } from '@/lib/home-client';

/**
 * Device pairing + account coordination.
 *
 * Two systems stay distinct here, as they are on the wire:
 * - Backend coordination (account ↔ home membership): backend address,
 *   account token, join ticket, member-home discovery, presence. The backend
 *   never sees private chat or device credentials.
 * - Home enrollment (this device ↔ home user): one-time invitation
 *   (invitation id + secret, single use, cleared after pairing). The home
 *   issues the device credential; sessions renew from secure storage.
 */
export function DevicePanel() {
  const c = useColors();
  const {
    settings,
    enrollHome,
    enrollWithSetupJson,
    revokeEnrollment,
    useDemoMode,
    verifyHomeConnection,
    connectionStatus,
    connectionError,
    enrollment,
    backend,
    account,
    configureBackend,
    clearBackend,
    refreshAccountConfig,
    signInWithProvider,
    signOutAccount,
    retryAccountRefresh,
    refreshBackendHomes,
    joinBackendHome,
    selectBackendHome,
    mintActivationTicket,
    notifications,
    enableNotifications,
    disableNotifications,
  } = useMe();
  useEffect(() => {
    if (backend.backendUrl) {
      void refreshAccountConfig();
    }
  }, [backend.backendUrl, refreshAccountConfig]);
  const [homeUrl, setHomeUrl] = useState(settings.homeUrl);
  const [invitationId, setInvitationId] = useState('');
  const [pairingSecret, setPairingSecret] = useState('');
  const [setupJson, setSetupJson] = useState('');
  const [setupError, setSetupError] = useState<string | null>(null);
  const [backendUrl, setBackendUrl] = useState('');
  const [accountToken, setAccountToken] = useState('');
  const [joinHomeId, setJoinHomeId] = useState('');
  const [ticketSecret, setTicketSecret] = useState('');
  // One-time activation ticket (F9): ephemeral UI state only — never
  // persisted, never logged, cleared on expiry/account change/background.
  // Lifecycle rule (F9 review): an in-flight mint or copy MUST NOT publish
  // after clear/discard/background/account change/unmount/expiry. Every
  // async step is fenced by the single reusable EphemeralRequestGuard:
  // invalidate() on every scope exit, isCurrent(gen) after every await.
  const [activationInstallationId, setActivationInstallationId] = useState('');
  const [activationDisplayName, setActivationDisplayName] = useState('');
  const [activationMode, setActivationMode] = useState<'new' | 'recovery'>('new');
  const [activationHomeId, setActivationHomeId] = useState('');
  const [activationBusy, setActivationBusy] = useState(false);
  const [activationTicket, setActivationTicket] = useState<ActivationTicket | null>(null);
  const [activationHandoff, setActivationHandoff] = useState<ActivationHandoff | null>(null);
  const [activationError, setActivationError] = useState<string | null>(null);
  const [activationExpired, setActivationExpired] = useState(false);
  const [revealSecret, setRevealSecret] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [copyError, setCopyError] = useState<string | null>(null);
  const ticketGuard = useRef<EphemeralRequestGuard | null>(null);
  if (!ticketGuard.current) ticketGuard.current = new EphemeralRequestGuard();
  // Ref mirrors for post-await staleness checks (closures go stale).
  const ticketRef = useRef<ActivationTicket | null>(null);
  const handoffRef = useRef<ActivationHandoff | null>(null);

  const clearActivationTicket = () => {
    // Retire the generation FIRST so any in-flight promise arriving later
    // is refused before it can repopulate the cleared secret.
    ticketGuard.current?.invalidate();
    ticketRef.current = null;
    handoffRef.current = null;
    setActivationTicket(null);
    setActivationHandoff(null);
    setActivationError(null);
    setRevealSecret(false);
    setCopyState('idle');
    setCopyError(null);
  };

  // Generation fence: a different account (or sign-out, or logout→login to
  // the SAME identity — the status transition retires the generation) drops
  // the one-time material immediately. The paired home is untouched — only
  // this ephemeral section clears.
  const accountFence = activationScopeFingerprint({
    accountId: account.accountId,
    issuer: account.issuer,
    backendUrl: account.backendUrl,
    status: account.status,
  });
  useEffect(() => {
    clearActivationTicket();
    setActivationExpired(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountFence]);

  // Backgrounding the app discards the displayed one-time secret.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next !== 'active') clearActivationTicket();
    });
    return () => subscription.remove();
  }, []);

  // Unmount retires the generation: a late promise cannot setState a
  // repopulated secret afterwards.
  useEffect(() => () => {
    ticketGuard.current?.invalidate();
  }, []);

  // Expiry fence: the ticket lives ~5 minutes; clear it the moment it lapses.
  useEffect(() => {
    if (!activationTicket) return;
    const timer = setInterval(() => {
      if (isActivationTicketExpired(activationTicket)) {
        clearActivationTicket();
        setActivationExpired(true);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [activationTicket]);

  const mintTicket = async () => {
    const guard = ticketGuard.current ?? new EphemeralRequestGuard();
    // True busy guard (ref, not state): a double-tap before the first
    // setState flush gets null here and never fires a second mint.
    const gen = guard.tryAcquire();
    if (gen === null) return;
    setActivationError(null);
    setActivationExpired(false);
    setCopyState('idle');
    setCopyError(null);
    const installationId = activationInstallationId.trim();
    if (!installationId) {
      guard.release(gen);
      setActivationError('Enter the installation ID exactly as shown by the home setup prepare step.');
      return;
    }
    if (activationMode === 'recovery' && !activationHomeId) {
      guard.release(gen);
      setActivationError('Pick the owned home to recover.');
      return;
    }
    if (account.status !== 'signed-in' || !account.accountId) {
      guard.release(gen);
      setActivationError('Sign in with the home owner account first, then mint a ticket.');
      return;
    }
    const scopeBefore = activationScopeFingerprint({
      accountId: account.accountId,
      issuer: account.issuer,
      backendUrl: account.backendUrl,
      status: account.status,
    });
    setActivationBusy(true);
    try {
      const result = await mintActivationTicket({
        installationId,
        ...(activationDisplayName.trim() ? { displayName: activationDisplayName.trim() } : {}),
        ...(activationMode === 'recovery' ? { existingHomeId: activationHomeId } : {}),
      });
      // Late arrival after background/discard/unmount/account change is
      // refused: never repopulate a cleared secret. The scope compare also
      // covers logout→login to the same identity (status transition).
      if (!guard.isCurrent(gen)) return;
      const scopeAfter = activationScopeFingerprint({
        accountId: account.accountId,
        issuer: account.issuer,
        backendUrl: account.backendUrl,
        status: account.status,
      });
      if (scopeAfter !== scopeBefore) return;
      if (!result) {
        // Genuinely unknown outcome (a timeout may follow a server-side
        // mint): assert nothing, retry nothing automatically.
        setActivationError(UNKNOWN_TICKET_OUTCOME_MESSAGE);
        return;
      }
      // A ticket that is already expired on arrival is never published.
      if (!shouldPublishTicketArrival(result.ticket, gen, guard)) {
        clearActivationTicket();
        setActivationExpired(true);
        return;
      }
      ticketRef.current = result.ticket;
      handoffRef.current = result.handoff;
      setActivationTicket(result.ticket);
      setActivationHandoff(result.handoff);
      setRevealSecret(false);
    } finally {
      guard.release(gen);
      setActivationBusy(false);
    }
  };

  const copyHandoff = async () => {
    const guard = ticketGuard.current ?? new EphemeralRequestGuard();
    const gen = guard.current();
    const handoff = handoffRef.current;
    if (!handoff) return;
    setCopyError(null);
    const text = JSON.stringify(handoff, null, 2);
    const result = await copyTextToClipboard(text);
    // Stale copy feedback (scope/expiry/discard moved mid-copy) is never
    // published. The OS clipboard itself is left alone: ownership cannot
    // be proven afterwards, so an indiscriminate wipe would destroy the
    // user's own text.
    if (!shouldPublishCopyFeedback(gen, guard)) return;
    if (handoffRef.current === null || ticketRef.current === null) return;
    if (isActivationTicketExpired(ticketRef.current)) return;
    if (result.ok) {
      setCopyState('copied');
    } else {
      setCopyState('failed');
      setCopyError(result.reason);
    }
  };

  const maskOneTimeSecret = (secret: string) =>
    secret.length <= 8 ? '••••••••' : `${secret.slice(0, 4)}…${secret.slice(-4)}`;

  const ownerHomes = backend.memberHomes.filter((h) => h.role === 'owner');
  const handoffDisplayText = activationHandoff
    ? JSON.stringify(
      revealSecret
        ? activationHandoff
        : { ...activationHandoff, activationSecret: maskOneTimeSecret(activationHandoff.activationSecret) },
      null,
      2,
    )
    : null;
  const connected = settings.assistantMode === 'home' && connectionStatus === 'connected';
  const working = connectionStatus === 'connecting';
  const statusLabel = settings.assistantMode === 'demo'
    ? 'DISCONNECTED'
    : connectionStatus === 'connecting'
      ? 'CONNECTING'
      : connectionStatus === 'connected'
        ? 'CONNECTED'
        : connectionStatus === 'offline'
          ? 'OFFLINE · WILL QUEUE'
          : connectionStatus === 'error'
            ? 'CONNECTION ERROR'
            : 'DISCONNECTED';

  const pair = async () => {
    const ok = await enrollHome({ homeBaseUrl: homeUrl, invitationId, pairingSecret });
    if (ok) {
      // Single-use invitation material never lingers in the UI.
      setPairingSecret('');
      setInvitationId('');
      setSetupJson('');
      setSetupError(null);
    }
  };

  const pairWithSetupJson = async () => {
    setSetupError(null);
    try {
      const ok = await enrollWithSetupJson(setupJson);
      if (ok) {
        // The pasted payload holds a one-time secret: clear it right away.
        setSetupJson('');
        setSetupError(null);
        setPairingSecret('');
        setInvitationId('');
      } else {
        setSetupError('That setup code was not accepted. Check the connection and try again.');
      }
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : 'That setup code was not accepted.');
    }
  };

  return (
    <ScrollView style={{ backgroundColor: c.background, flex: 1 }} contentContainerStyle={{ paddingBottom: 130 }}>
      <View style={{ paddingHorizontal: 20 }}>
        <View style={st.hero}>
          <Image source={require('@/assets/images/me-home-room.jpg')} style={StyleSheet.absoluteFill} contentFit="cover" />
        </View>
        <Text style={{ fontFamily: F.regular, fontSize: 14, lineHeight: 20, color: c.mutedForeground, marginTop: 12 }}>
          Me Home runs your assistant in your home. Pair this phone with a one-time invitation, then chat goes directly to your home — not through a cloud model. Account membership is coordinated separately below.
        </Text>

        <Card style={{ marginTop: 18 }}>
          <View style={st.row}>
            <Image source={require('@/assets/images/me-home.png')} style={{ width: 56, height: 56, borderRadius: 10 }} contentFit="cover" />
            <View style={{ flex: 1 }}>
              <Text style={{ fontFamily: F.medium, fontSize: 17, color: c.foreground }}>Me Home</Text>
              <View style={[st.row, { gap: 6, marginTop: 4 }]}>
                <StatusDot on={connected} />
                <Text accessibilityLiveRegion="polite" style={{ fontFamily: F.mono, fontSize: 11, color: connectionStatus === 'error' ? c.destructive : c.mutedForeground }}>
                  {statusLabel}
                </Text>
              </View>
              {enrollment ? (
                <Text style={{ fontFamily: F.mono, fontSize: 10, color: c.mutedForeground, marginTop: 4 }}>
                  {`home ${enrollment.homeId.slice(0, 8)}… · device ${enrollment.deviceId.slice(0, 12)}… · user ${enrollment.userId}`}
                </Text>
              ) : null}
            </View>
          </View>

          <Text style={[st.label, { color: c.foreground }]}>Home endpoint</Text>
          <TextInput
            testID="me-home-url"
            accessibilityLabel="Me Home endpoint address"
            value={homeUrl}
            onChangeText={setHomeUrl}
            placeholder="http://127.0.0.1:7070 (local) or https://home.example.com"
            placeholderTextColor={c.mutedForeground}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            editable={!working}
            style={[st.input, { color: c.foreground, backgroundColor: c.background, borderColor: c.border }]}
          />
          <Text style={[st.label, { color: c.foreground }]}>One-time invitation ID</Text>
          <TextInput
            testID="me-home-invitation-id"
            accessibilityLabel="One-time invitation ID"
            value={invitationId}
            onChangeText={setInvitationId}
            placeholder="inv_… (single use, from the home)"
            placeholderTextColor={c.mutedForeground}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!working}
            style={[st.input, { color: c.foreground, backgroundColor: c.background, borderColor: c.border }]}
          />
          <Text style={[st.label, { color: c.foreground }]}>Invitation secret</Text>
          <TextInput
            testID="me-home-invitation-secret"
            accessibilityLabel="One-time invitation secret"
            value={pairingSecret}
            onChangeText={setPairingSecret}
            placeholder="Shown once when the invitation is created"
            placeholderTextColor={c.mutedForeground}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            editable={!working}
            style={[st.input, { color: c.foreground, backgroundColor: c.background, borderColor: c.border }]}
          />
          <View style={{ marginTop: 14 }}>
            <Button
              testID="connect-me-home"
              variant="accent"
              icon="shield"
              label={working ? 'Pairing this phone' : 'Pair with one-time invitation'}
              disabled={working}
              onPress={() => { void pair(); }}
            />
          </View>

          {connectionStatus === 'connecting' ? (
            <Text accessibilityLiveRegion="polite" style={{ fontFamily: F.regular, fontSize: 13, color: c.mutedForeground, marginTop: 10 }}>
              Pairing this phone. No chat is sent until the home confirms enrollment.
            </Text>
          ) : null}
          {connectionStatus === 'offline' ? (
            <Text accessibilityLiveRegion="polite" style={{ fontFamily: F.regular, fontSize: 13, color: c.mutedForeground, marginTop: 10 }}>
              Me Home is unreachable. Messages queue on this device and send on reconnect.
            </Text>
          ) : null}
          {connectionError ? (
            <Text accessibilityLiveRegion="assertive" testID="me-home-error" style={{ fontFamily: F.regular, fontSize: 13, lineHeight: 19, color: c.destructive, marginTop: 10 }}>
              {connectionError}
            </Text>
          ) : null}
          {connected ? (
            <Text style={{ fontFamily: F.regular, fontSize: 13, color: c.mutedForeground, marginTop: 10 }}>
              Paired. The device credential lives in this phone's secure storage; sessions renew from it without repeating setup.
            </Text>
          ) : null}

          {settings.assistantMode === 'home' ? (
            <View style={{ marginTop: 10, gap: 8 }}>
              <Button
                testID="verify-me-home"
                variant="ghost"
                icon="refresh-cw"
                label="Recheck connection"
                onPress={() => { void verifyHomeConnection(); }}
              />
              <Button
                testID="revoke-me-home"
                variant="danger"
                icon="x-circle"
                label="Revoke this device"
                onPress={() => { void revokeEnrollment(); }}
              />
              <Button
                testID="use-demo-mode"
                variant="ghost"
                icon="play-circle"
                label="Disconnect Me Home"
                onPress={() => { void useDemoMode(); }}
              />
            </View>
          ) : null}
        </Card>

        <Card style={{ marginTop: 14 }}>
          <Text style={{ fontFamily: F.medium, fontSize: 14, color: c.foreground }}>Paste home setup code</Text>
          <Text style={{ fontFamily: F.regular, fontSize: 13, lineHeight: 19, color: c.mutedForeground, marginTop: 6 }}>
            From your home's setup screen, copy the one-time home-pairing code and paste it here. The address inside comes from your trusted home — member-list hints are never used as pairing addresses.
          </Text>
          <TextInput
            testID="me-home-setup-json"
            accessibilityLabel="Home setup code"
            value={setupJson}
            onChangeText={(v) => { setSetupJson(v); setSetupError(null); }}
            placeholder='{"protocol":"home-pairing-v1", …}'
            placeholderTextColor={c.mutedForeground}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            editable={!working}
            style={[st.input, { color: c.foreground, backgroundColor: c.background, borderColor: c.border, minHeight: 64 }]}
          />
          {setupError ? (
            <Text testID="me-home-setup-error" style={{ fontFamily: F.regular, fontSize: 13, color: c.destructive, marginTop: 8 }}>
              {setupError}
            </Text>
          ) : null}
          <View style={{ marginTop: 10 }}>
            <Button
              testID="pair-with-setup-json"
              variant="accent"
              icon="clipboard"
              label="Pair with setup code"
              disabled={working || !setupJson.trim()}
              onPress={() => { void pairWithSetupJson(); }}
            />
          </View>
        </Card>

        <Card style={{ marginTop: 14 }}>
          <Text style={{ fontFamily: F.medium, fontSize: 14, color: c.foreground }}>Task notifications</Text>
          <Text style={{ fontFamily: F.regular, fontSize: 13, lineHeight: 19, color: c.mutedForeground, marginTop: 6 }}>
            {Platform.OS === 'web'
              ? 'Push notifications need the native app. The web preview never sends or receives pushes.'
              : notifications.enabled
                ? `On — this phone alerts when your home needs you.${notifications.tokenSuffix ? ` Push token …${notifications.tokenSuffix.slice(-8)}.` : ''}`
                : 'Off — nothing is registered until you opt in. When your home needs you while the app is closed, it stays silent.'}
          </Text>
          {Platform.OS !== 'web' ? (
            <View style={{ marginTop: 10, gap: 8 }}>
              {notifications.enabled ? (
                <Button
                  testID="notifications-disable"
                  variant="ghost"
                  icon="bell-off"
                  label="Turn off notifications"
                  disabled={notifications.busy}
                  onPress={() => { void disableNotifications(); }}
                />
              ) : (
                <Button
                  testID="notifications-enable"
                  variant="accent"
                  icon="bell"
                  label={notifications.busy ? 'Enabling' : 'Notify me on this phone'}
                  disabled={notifications.busy || settings.assistantMode !== 'home'}
                  onPress={() => { void enableNotifications(); }}
                />
              )}
              {settings.assistantMode !== 'home' && !notifications.enabled ? (
                <Text style={{ fontFamily: F.regular, fontSize: 12, color: c.mutedForeground }}>
                  Pair with your home first, then enable notifications.
                </Text>
              ) : null}
              {notifications.error ? (
                <Text testID="notifications-error" style={{ fontFamily: F.regular, fontSize: 13, color: c.destructive }}>
                  {notifications.error}
                </Text>
              ) : null}
            </View>
          ) : null}
        </Card>

        <Card style={{ marginTop: 14 }}>
          <Text style={{ fontFamily: F.medium, fontSize: 14, color: c.foreground }}>Me Home API contract</Text>
          <Text style={{ fontFamily: F.regular, fontSize: 13, lineHeight: 19, color: c.mutedForeground, marginTop: 6 }}>
            This build speaks home-api-v1 plus opt-in home-notifications-v1 (register/status/disable, metadata-only pushes). The old /api/assistant/chat bearer-token route is gone.
          </Text>
        </Card>

        <Card style={{ marginTop: 14 }}>
          <Text style={{ fontFamily: F.medium, fontSize: 14, color: c.foreground }}>Me account</Text>
          <Text style={{ fontFamily: F.regular, fontSize: 13, lineHeight: 19, color: c.mutedForeground, marginTop: 6 }}>
            Secure provider sign-in on this phone. The verified account unlocks home discovery; your home pairing stays separate and never leaves this device.
          </Text>
          {Platform.OS === 'web' ? (
            <Text style={{ fontFamily: F.regular, fontSize: 13, lineHeight: 19, color: c.mutedForeground, marginTop: 10 }}>
              Secure sign-in needs the native app. The web preview cannot persist credentials and offers no sign-in button.
            </Text>
          ) : account.status === 'signed-in' ? (
            <View style={{ marginTop: 10, gap: 8 }}>
              <Text accessibilityLiveRegion="polite" style={{ fontFamily: F.mono, fontSize: 11, color: c.mutedForeground }}>
                {`SIGNED IN · ${String(account.accountId ?? '').slice(0, 18)}…`}
              </Text>
              {account.issuer ? (
                <Text style={{ fontFamily: F.mono, fontSize: 10, color: c.mutedForeground }} numberOfLines={1}>
                  {account.issuer}
                </Text>
              ) : null}
              <Button testID="account-sign-out" variant="ghost" icon="log-out" label="Sign out" onPress={() => { void signOutAccount(); }} />
              {account.error ? (
                <Text testID="account-error" style={{ fontFamily: F.regular, fontSize: 13, color: c.destructive }}>
                  {account.error}
                </Text>
              ) : null}
              <Button testID="account-refresh" variant="ghost" icon="refresh-cw" label="Refresh session" onPress={() => { void retryAccountRefresh(); }} />
            </View>
          ) : (
            <View style={{ marginTop: 10, gap: 8 }}>
              <Button
                testID="account-sign-in"
                variant="accent"
                icon="shield"
                label={account.status === 'signing-in' ? 'Opening secure sign-in' : 'Sign in'}
                disabled={account.status === 'signing-in'}
                onPress={() => { void signInWithProvider(); }}
              />
              {account.status === 'signing-in' ? (
                <Text accessibilityLiveRegion="polite" style={{ fontFamily: F.regular, fontSize: 13, color: c.mutedForeground }}>
                  Opening the secure browser. Complete sign-in there; this app never sees your password.
                </Text>
              ) : null}
              {account.status === 'cancelled' ? (
                <Text accessibilityLiveRegion="polite" testID="account-cancelled" style={{ fontFamily: F.regular, fontSize: 13, color: c.mutedForeground }}>
                  Sign-in was cancelled. Nothing was saved — try again when ready.
                </Text>
              ) : null}
              {account.status === 'not-ready' ? (
                <Text accessibilityLiveRegion="polite" testID="account-not-ready" style={{ fontFamily: F.regular, fontSize: 13, color: c.mutedForeground }}>
                  {account.error ?? 'Sign-in is not ready yet. The operator needs to configure login metadata.'}
                </Text>
              ) : null}
              {account.status === 'error' && account.error ? (
                <View style={{ gap: 8 }}>
                  <Text accessibilityLiveRegion="assertive" testID="account-error" style={{ fontFamily: F.regular, fontSize: 13, color: c.destructive }}>
                    {account.error}
                  </Text>
                  <Button testID="account-retry" variant="ghost" icon="refresh-cw" label="Try again" onPress={() => { void signInWithProvider(); }} />
                </View>
              ) : null}
            </View>
          )}
        </Card>

        {account.status === 'signed-in' ? (
          <Card style={{ marginTop: 14 }}>
            <Text style={{ fontFamily: F.medium, fontSize: 14, color: c.foreground }}>Home activation ticket</Text>
            <Text style={{ fontFamily: F.regular, fontSize: 13, lineHeight: 19, color: c.mutedForeground, marginTop: 6 }}>
              Mint a one-time ticket for the home operator to paste into home setup (stdin). This is cloud account
              membership only — it does not pair this phone and never changes your trusted local home pairing. The
              phone never activates; the home redeems the ticket itself.
            </Text>
            <Text style={[st.label, { color: c.foreground }]}>Home installation ID</Text>
            <TextInput
              testID="activation-installation-id"
              accessibilityLabel="Home installation ID from setup prepare"
              value={activationInstallationId}
              onChangeText={setActivationInstallationId}
              placeholder="Copied from the physical home setup prepare step"
              placeholderTextColor={c.mutedForeground}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!activationBusy}
              style={[st.input, { color: c.foreground, backgroundColor: c.background, borderColor: c.border }]}
            />
            <Text style={[st.label, { color: c.foreground }]}>Display name (new homes, optional)</Text>
            <TextInput
              testID="activation-display-name"
              accessibilityLabel="Display name for a new home"
              value={activationDisplayName}
              onChangeText={setActivationDisplayName}
              placeholder="Cabin Home"
              placeholderTextColor={c.mutedForeground}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!activationBusy}
              style={[st.input, { color: c.foreground, backgroundColor: c.background, borderColor: c.border }]}
            />
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
              <Button
                testID="activation-mode-new"
                label="New home"
                variant={activationMode === 'new' ? 'accent' : 'ghost'}
                onPress={() => setActivationMode('new')}
              />
              <Button
                testID="activation-mode-recovery"
                label="Recover home"
                variant={activationMode === 'recovery' ? 'accent' : 'ghost'}
                onPress={() => setActivationMode('recovery')}
              />
            </View>
            {activationMode === 'recovery' ? (
              <View style={{ marginTop: 8 }}>
                <Text style={{ fontFamily: F.regular, fontSize: 12, color: c.mutedForeground }}>
                  Owner-only: pick one of your homes whose installation matches. Anything else is refused before sending;
                  the backend decides authoritatively.
                </Text>
                {ownerHomes.length === 0 ? (
                  <Text style={{ fontFamily: F.regular, fontSize: 13, color: c.mutedForeground, marginTop: 8 }}>
                    No owned homes discovered yet. Refresh my homes below first.
                  </Text>
                ) : (
                  ownerHomes.map((home) => {
                    const matches =
                      !home.installationId || home.installationId === activationInstallationId.trim();
                    return (
                      <View key={home.homeId} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 }}>
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontFamily: F.medium, fontSize: 13, color: c.foreground }} numberOfLines={1}>
                            {home.displayName ?? home.homeId}
                          </Text>
                          <Text style={{ fontFamily: F.mono, fontSize: 10, color: matches ? c.mutedForeground : c.destructive }}>
                            {`${home.homeId.slice(0, 20)} · ${matches ? 'installation matches' : 'installation differs — will be refused'}`}
                          </Text>
                        </View>
                        <Button
                          testID={`activation-home-${home.homeId}`}
                          label={activationHomeId === home.homeId ? 'Selected' : 'Select'}
                          variant={activationHomeId === home.homeId ? 'accent' : 'ghost'}
                          onPress={() => setActivationHomeId(home.homeId)}
                        />
                      </View>
                    );
                  })
                )}
              </View>
            ) : null}
            <View style={{ marginTop: 12 }}>
              <Button
                testID="activation-mint"
                variant="accent"
                icon="key"
                label={activationBusy ? 'Minting one-time ticket' : 'Mint one-time ticket'}
                disabled={activationBusy || !activationInstallationId.trim()}
                onPress={() => { void mintTicket(); }}
              />
            </View>
            {activationError ? (
              <Text testID="activation-error" style={{ fontFamily: F.regular, fontSize: 13, color: c.destructive, marginTop: 10 }}>
                {activationError}
              </Text>
            ) : null}
            {activationExpired ? (
              <Text accessibilityLiveRegion="polite" style={{ fontFamily: F.regular, fontSize: 13, color: c.mutedForeground, marginTop: 10 }}>
                That ticket expired and was discarded. Mint a fresh one when the operator is ready.
              </Text>
            ) : null}
            {activationHandoff && handoffDisplayText ? (
              <View style={{ marginTop: 12, gap: 8 }}>
                <Text style={{ fontFamily: F.regular, fontSize: 12, color: c.destructive }}>
                  One-time secret — shown once. It is never stored or logged; leaving this screen, backgrounding the
                  app, signing out, or expiry discards it.
                </Text>
                <Text
                  testID="activation-handoff"
                  selectable
                  style={{ fontFamily: F.mono, fontSize: 11, color: c.foreground, backgroundColor: c.background, borderColor: c.border, borderWidth: 1, borderRadius: 10, padding: 12 }}
                >
                  {handoffDisplayText}
                </Text>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Button
                    testID="activation-reveal"
                    label={revealSecret ? 'Hide secret' : 'Reveal secret'}
                    variant="ghost"
                    onPress={() => setRevealSecret((v) => !v)}
                  />
                  <Button
                    testID="activation-copy"
                    label={copyState === 'copied' ? 'Copied' : 'Copy handoff JSON'}
                    variant="accent"
                    icon="clipboard"
                    onPress={() => { void copyHandoff(); }}
                  />
                  <Button
                    testID="activation-discard"
                    label="Discard now"
                    variant="danger"
                    onPress={() => { clearActivationTicket(); setActivationExpired(false); }}
                  />
                </View>
                {copyState === 'copied' ? (
                  <Text accessibilityLiveRegion="polite" style={{ fontFamily: F.regular, fontSize: 13, color: c.mutedForeground }}>
                    Copied to the clipboard. Paste it to the home operator; then discard it here.
                  </Text>
                ) : null}
                {copyState === 'failed' && copyError ? (
                  <Text testID="activation-copy-error" style={{ fontFamily: F.regular, fontSize: 13, color: c.destructive }}>
                    {copyError}
                  </Text>
                ) : null}
              </View>
            ) : null}
          </Card>
        ) : null}

        <Card style={{ marginTop: 14 }}>
          <Text style={{ fontFamily: F.medium, fontSize: 14, color: c.foreground }}>Account coordination</Text>
          <Text style={{ fontFamily: F.regular, fontSize: 13, lineHeight: 19, color: c.mutedForeground, marginTop: 6 }}>
            Membership only — the backend discovers homes and tracks presence. It never sees chat, tasks, or device credentials.
          </Text>
          <Text style={[st.label, { color: c.foreground }]}>Backend address</Text>
          <TextInput
            testID="backend-url"
            accessibilityLabel="Backend address"
            value={backendUrl || backend.backendUrl}
            onChangeText={setBackendUrl}
            placeholder="http://127.0.0.1:8787"
            placeholderTextColor={c.mutedForeground}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            style={[st.input, { color: c.foreground, backgroundColor: c.background, borderColor: c.border }]}
          />
          <Text style={[st.label, { color: c.foreground }]}>Local-dev account token</Text>
          <Text style={{ fontFamily: F.regular, fontSize: 12, color: c.mutedForeground, marginTop: 4 }}>
            Local development only (loopback dev backends). Hosted backends use Sign in above.
          </Text>
          <TextInput
            testID="backend-account-token"
            accessibilityLabel="Local-dev account token"
            value={accountToken}
            onChangeText={setAccountToken}
            placeholder="Stored in secure storage, never logged"
            placeholderTextColor={c.mutedForeground}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            style={[st.input, { color: c.foreground, backgroundColor: c.background, borderColor: c.border }]}
          />
          <View style={{ marginTop: 14 }}>
            <Button
              testID="backend-configure"
              variant="accent"
              icon="server"
              label={backend.backendUrl ? 'Update coordination' : 'Connect dev account'}
              onPress={() => { void configureBackend(backendUrl || backend.backendUrl, accountToken).then((ok) => { if (ok) setAccountToken(''); }); }}
            />
          </View>
          {backend.backendError ? (
            <Text testID="backend-error" style={{ fontFamily: F.regular, fontSize: 13, color: c.destructive, marginTop: 10 }}>
              {backend.backendError}
            </Text>
          ) : null}
          {backend.backendUrl ? (
            <View style={{ marginTop: 12, gap: 8 }}>
              <Button testID="backend-refresh" variant="ghost" icon="refresh-cw" label="Refresh my homes" onPress={() => { void refreshBackendHomes(); }} />
              <Text style={{ fontFamily: F.regular, fontSize: 12, color: c.mutedForeground }}>
                Membership only. Check verifies a listed home is reachable; pairing always needs a fresh one-time invitation from your trusted home setup.
              </Text>
              {backend.memberHomes.map((home) => {
                const presence = backend.presence[home.homeId];
                const presenceLabel = presence?.lastStatus === 'online'
                  ? 'HOME ONLINE'
                  : presence?.lastStatus
                    ? `HOME ${String(presence.lastStatus).toUpperCase()}`
                    : 'PRESENCE UNKNOWN';
                return (
                  <View key={home.homeId} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontFamily: F.medium, fontSize: 13, color: c.foreground }} numberOfLines={1}>
                        {home.displayName ?? home.homeId}
                      </Text>
                      <Text style={{ fontFamily: F.mono, fontSize: 10, color: c.mutedForeground }}>
                        {`${home.homeId.slice(0, 20)} · ${presenceLabel}`}
                      </Text>
                    </View>
                    <Button testID={`backend-use-${home.homeId}`} label="Check" variant="ghost" onPress={() => { void selectBackendHome(home.homeId); }} />
                  </View>
                );
              })}
              <Text style={[st.label, { color: c.foreground }]}>Join a home (home ID + join ticket)</Text>
              <TextInput
                testID="backend-join-home-id"
                accessibilityLabel="Home ID to join"
                value={joinHomeId}
                onChangeText={setJoinHomeId}
                placeholder="home-…"
                placeholderTextColor={c.mutedForeground}
                autoCapitalize="none"
                autoCorrect={false}
                style={[st.input, { color: c.foreground, backgroundColor: c.background, borderColor: c.border }]}
              />
              <TextInput
                testID="backend-join-ticket"
                accessibilityLabel="Join ticket secret"
                value={ticketSecret}
                onChangeText={setTicketSecret}
                placeholder="Single-use ticket from the home"
                placeholderTextColor={c.mutedForeground}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                style={[st.input, { color: c.foreground, backgroundColor: c.background, borderColor: c.border }]}
              />
              <Button
                testID="backend-join"
                label="Join home"
                variant="accent"
                onPress={() => { void joinBackendHome(joinHomeId, ticketSecret).then((ok) => { if (ok) setTicketSecret(''); }); }}
              />
              <Button testID="backend-clear" label="Forget account coordination" variant="ghost" onPress={() => { void clearBackend(); }} />
            </View>
          ) : null}
        </Card>

        <Text style={{ fontFamily: F.regular, fontSize: 12, lineHeight: 17, color: c.mutedForeground, marginTop: 14 }}>
          No chat is sent while disconnected. On the web preview, secure pairing is disabled; use the native mobile app to pair. Calls remain simulated previews with no audio transport; the browser view is user-directed only.
        </Text>
      </View>
    </ScrollView>
  );
}

const st = StyleSheet.create({
  hero: { height: 220, borderRadius: 16, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  label: { fontFamily: F.medium, fontSize: 13, marginTop: 16, marginBottom: 6 },
  input: { minHeight: 46, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, fontFamily: F.regular, fontSize: 14 },
});
