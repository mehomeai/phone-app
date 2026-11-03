import React, { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Button, Card, F, StatusDot } from '@/components/ui';
import { useMe } from '@/context/MeContext';
import { useColors } from '@/hooks/useColors';
import { summarizeApproval } from '@/lib/home-client';
import type { TaskView } from '@/lib/home-client';
import type { SavedArtifact } from '@/lib/artifact-store';
import {
  canPreviewInline,
  decodeTextPreview,
  isPreviewableImage,
  isPreviewableText,
} from '@/lib/artifact-store';
import { Image } from 'expo-image';

const TERMINAL = ['succeeded', 'failed', 'cancelled'];

function statusColor(status: TaskView['status'], c: { accent: string; destructive: string; mutedForeground: string }) {
  if (status === 'succeeded') return c.accent;
  if (status === 'failed' || status === 'cancelled') return c.destructive;
  return c.mutedForeground;
}

/**
 * Persisted-task surface (H2) reusing the existing visual components.
 * All state is home-owned: this panel submits, polls, answers, approves,
 * cancels, and saves artifacts. Nothing is fabricated here — with no usable
 * home model the home refuses honestly (MODEL_NOT_CONFIGURED) and that
 * message is shown instead of fake progress.
 *
 * Artifact flow (F5): fetch reuses the home client's `fetchTaskArtifact`
 * bytes, then `saveTaskArtifact` writes them to the app-private scoped
 * cache (identity-scoped dir, random/safe filename, max-bytes enforced).
 * "Saved" is shown ONLY after the write verifies. The user then invokes
 * Open (platform viewer) or Share (native sheet) explicitly. Inline preview
 * is bounded text or safe raster images only — never HTML/SVG/JS, never a
 * WebView, never openURL. Web falls back to a blob download.
 *
 * Approvals (F6): each pending approval renders as a reviewable card —
 * action, summary, reason, destination URL / selector or action-sequence
 * steps, and expiry — as native Text (never HTML, never auto-opened URLs).
 * Sensitive arg values are masked by default; technical metadata
 * (args hash / effective caps) stays behind an explicit Details toggle.
 * Approval ids are opaque server values used verbatim; decisions are the
 * canonical `approve` / `reject`.
 *
 * Privacy (F6): local answers, saved-file handles, text previews, and notes
 * are cleared on FULL scope change or conversation change, and async
 * download/preview callbacks are fenced against the scope key so a
 * previous user's preview can never flash.
 */
export function TaskPanel({ conversationId }: { conversationId: string | null }) {
  const c = useColors();
  const {
    settings,
    connectionStatus,
    tasksByConv,
    tasksLoading,
    taskErrors,
    taskArtifacts,
    homeScopeKey,
    identityResolved,
    refreshTasks,
    submitHomeTask,
    answerTaskQuestion,
    decideTaskApproval,
    cancelHomeTask,
    loadTaskArtifacts,
    downloadTaskArtifact,
    saveTaskArtifact,
  } = useMe();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [downloadNote, setDownloadNote] = useState<string | null>(null);
  const [savedByArtifact, setSavedByArtifact] = useState<Record<string, SavedArtifact>>({});
  const [previewTextByArtifact, setPreviewTextByArtifact] = useState<Record<string, string>>({});
  const [busyArtifact, setBusyArtifact] = useState<string | null>(null);
  const [revealedApprovals, setRevealedApprovals] = useState<Record<string, boolean>>({});

  // F6 privacy fence: local per-conversation UI state never survives a FULL
  // scope rotation or a conversation switch (no stale preview/answer flash).
  // Rendered tasks below are already scoped to the current authorized
  // conversation via tasksByConv[conversationId].
  useEffect(() => {
    setAnswers({});
    setSavedByArtifact({});
    setPreviewTextByArtifact({});
    setBusyArtifact(null);
    setDownloadNote(null);
    setRevealedApprovals({});
  }, [conversationId, homeScopeKey]);

  if (settings.assistantMode !== 'home' || !conversationId) return null;
  // Before the enrollment resolves, show nothing (no previous-user flash);
  // ChatComposer already gates scoped-out conversations.
  if (!identityResolved) return null;
  const tasks = tasksByConv[conversationId] ?? [];
  const loading = !!tasksLoading[conversationId];
  const error = taskErrors[conversationId];
  const canUse = connectionStatus === 'connected' || connectionStatus === 'offline';

  const download = async (taskId: string, artifactId: string) => {
    // Fence the async callback against scope + conversation moves.
    const fencedScope = homeScopeKey;
    const fencedConv = conversationId;
    const key = `${taskId}:${artifactId}`;
    setBusyArtifact(key);
    setDownloadNote(null);
    try {
      // F4 fence lives inside saveTaskArtifact: null means the pairing
      // moved mid-flight, so present no file (never a stale-identity save).
      const saved = await saveTaskArtifact(taskId, artifactId);
      if (fencedScope !== homeScopeKey || fencedConv !== conversationId) return;
      if (!saved) {
        setDownloadNote('Pairing changed while saving; no file was kept. Refresh and try again.');
        return;
      }
      setSavedByArtifact((current) => ({ ...current, [key]: saved }));
      const where = Platform.OS === 'web' ? 'downloaded via browser' : 'saved to this device';
      setDownloadNote(`${saved.name}: ${saved.size} bytes ${where} (home keeps the original).`);
    } catch (error) {
      if (fencedScope !== homeScopeKey || fencedConv !== conversationId) return;
      setDownloadNote(error instanceof Error ? error.message : 'Save failed.');
    } finally {
      if (fencedScope === homeScopeKey && fencedConv === conversationId) {
        setBusyArtifact(null);
      }
    }
  };

  const previewText = async (taskId: string, artifactId: string) => {
    const fencedScope = homeScopeKey;
    const fencedConv = conversationId;
    try {
      // Lazy bounded text preview: reuses the home-authoritative fetch, then
      // decodes at most 4000 chars. Never renders HTML.
      const { bytes } = await downloadTaskArtifact(taskId, artifactId);
      if (fencedScope !== homeScopeKey || fencedConv !== conversationId) return;
      const key = `${taskId}:${artifactId}`;
      setPreviewTextByArtifact((current) => ({ ...current, [key]: decodeTextPreview(bytes) }));
    } catch (error) {
      if (fencedScope !== homeScopeKey || fencedConv !== conversationId) return;
      setDownloadNote(error instanceof Error ? error.message : 'Preview failed.');
    }
  };

  const share = async (taskId: string, artifactId: string) => {
    const key = `${taskId}:${artifactId}`;
    const saved = savedByArtifact[key];
    if (!saved) return;
    try {
      const mod = await import('@/lib/artifact-store');
      await mod.shareArtifactFile(saved.fileUri, saved.mimeType);
    } catch (error) {
      setDownloadNote(error instanceof Error ? error.message : 'Share failed.');
    }
  };

  const openViewer = async (taskId: string, artifactId: string) => {
    const key = `${taskId}:${artifactId}`;
    const saved = savedByArtifact[key];
    if (!saved) return;
    try {
      const mod = await import('@/lib/artifact-store');
      await mod.previewArtifactFile(saved.fileUri);
    } catch {
      // Preview unsupported for this type/device: fall back to Share.
      await share(taskId, artifactId);
    }
  };

  return (
    <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border }}>
      <Pressable
        testID="task-toggle"
        accessibilityRole="button"
        onPress={() => {
          const next = !open;
          setOpen(next);
          if (next) void refreshTasks(conversationId);
        }}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 10 }}
      >
        <StatusDot on={connectionStatus === 'connected'} />
        <Text style={{ fontFamily: F.mono, fontSize: 11, letterSpacing: 1, color: c.mutedForeground }}>
          HOME TASKS · {tasks.length}{loading ? ' · UPDATING' : ''}
        </Text>
      </Pressable>
      {open ? (
        <View style={{ paddingHorizontal: 12, paddingBottom: 12, gap: 10 }}>
          {error ? (
            <Text testID="task-error" style={{ fontFamily: F.regular, fontSize: 13, color: c.destructive }}>{error}</Text>
          ) : null}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TextInput
              testID="task-input"
              value={draft}
              onChangeText={setDraft}
              editable={canUse && !loading}
              placeholder={connectionStatus === 'connected' ? 'Ask the home to do something' : 'Home offline — task runs when it reconnects'}
              placeholderTextColor={c.mutedForeground}
              style={[st.input, { flex: 1, color: c.foreground, backgroundColor: c.card, borderColor: c.border }]}
            />
            <Button testID="task-submit" label="Run" variant="accent" disabled={!draft.trim() || loading} onPress={submit} />
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
            <Button testID="task-refresh" label={loading ? 'Updating' : 'Refresh'} variant="ghost" disabled={loading} onPress={() => { void refreshTasks(conversationId); }} />
          </View>
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              allTasks={tasks}
              canUse={canUse}
              artifacts={taskArtifacts[task.id]}
              answers={answers}
              savedByArtifact={savedByArtifact}
              previewTextByArtifact={previewTextByArtifact}
              busyArtifact={busyArtifact}
              revealedApprovals={revealedApprovals}
              onToggleApprovalDetail={(aid) =>
                setRevealedApprovals((current) => ({ ...current, [`${task.id}:${aid}`]: !current[`${task.id}:${aid}`] }))
              }
              onAnswerText={(qid, text) => setAnswers((current) => ({ ...current, [`${task.id}:${qid}`]: text }))}
              onAnswer={(qid) => {
                const text = (answers[`${task.id}:${qid}`] ?? '').trim();
                if (!text) return;
                void answerTaskQuestion(task.id, qid, text);
              }}
              onApprove={(aid, decision) => { void decideTaskApproval(task.id, aid, decision); }}
              onCancel={() => { void cancelHomeTask(task.id); }}
              onArtifacts={() => { void loadTaskArtifacts(task.id); }}
              onDownload={(aid) => { void download(task.id, aid); }}
              onPreviewText={(aid) => { void previewText(task.id, aid); }}
              onShare={(aid) => { void share(task.id, aid); }}
              onOpen={(aid) => { void openViewer(task.id, aid); }}
            />
          ))}
          {downloadNote ? (
            <Text style={{ fontFamily: F.regular, fontSize: 12, color: c.mutedForeground }}>{downloadNote}</Text>
          ) : null}
          {!loading && tasks.length === 0 && !error ? (
            <Text style={{ fontFamily: F.regular, fontSize: 13, color: c.mutedForeground }}>
              No home tasks yet. Tasks run on your home computer and survive app restarts; progress appears here on refresh.
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );

  function submit() {
    const clean = draft.trim();
    if (!clean || loading) return;
    setDraft('');
    void submitHomeTask(conversationId as string, { request: clean });
  }
}

function TaskCard({ task, allTasks, canUse, artifacts, answers, savedByArtifact, previewTextByArtifact, busyArtifact, revealedApprovals, onToggleApprovalDetail, onAnswerText, onAnswer, onApprove, onCancel, onArtifacts, onDownload, onPreviewText, onShare, onOpen }: {
  task: TaskView;
  /** All tasks in this conversation (home-authoritative list) for relationship labels. */
  allTasks: TaskView[];
  canUse: boolean;
  artifacts: TaskView['artifacts'];
  answers: Record<string, string>;
  savedByArtifact: Record<string, SavedArtifact>;
  previewTextByArtifact: Record<string, string>;
  busyArtifact: string | null;
  revealedApprovals: Record<string, boolean>;
  onToggleApprovalDetail: (aid: string) => void;
  onAnswerText: (qid: string, text: string) => void;
  onAnswer: (qid: string) => void;
  onApprove: (aid: string, decision: 'approve' | 'reject') => void;
  onCancel: () => void;
  onArtifacts: () => void;
  onDownload: (aid: string) => void;
  onPreviewText: (aid: string) => void;
  onShare: (aid: string) => void;
  onOpen: (aid: string) => void;
}) {
  const c = useColors();
  const terminal = TERMINAL.includes(task.status);
  const byId = new Map(allTasks.map((t) => [t.id, t]));
  const childIds = Array.isArray(task.childTaskIds) ? task.childTaskIds.filter((id) => typeof id === 'string') : [];
  const waitingIds = Array.isArray(task.waitingChildren) ? task.waitingChildren.filter((id) => typeof id === 'string') : [];
  const parentView = typeof task.parentTaskId === 'string' ? byId.get(task.parentTaskId) : undefined;
  return (
    <Card testID={`task-${task.id}`} style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <StatusDot on={task.status === 'succeeded'} />
        <Text style={{ fontFamily: F.medium, fontSize: 14, color: c.foreground, flex: 1 }} numberOfLines={2}>
          {task.title}
        </Text>
        <Text style={{ fontFamily: F.mono, fontSize: 10, color: statusColor(task.status, c) }}>
          {task.status.toUpperCase().replace('_', ' ')}
        </Text>
      </View>
      {typeof task.parentTaskId === 'string' && task.parentTaskId ? (
        <Text style={{ fontFamily: F.regular, fontSize: 12, color: c.mutedForeground }}>
          {parentView ? `Subtask of “${parentView.title}” (${parentView.status})` : `Subtask of ${task.parentTaskId}`}
        </Text>
      ) : null}
      {typeof task.rootTaskId === 'string' && task.rootTaskId && task.rootTaskId !== task.parentTaskId ? (
        <Text style={{ fontFamily: F.mono, fontSize: 10, color: c.mutedForeground }}>
          ROOT {task.rootTaskId}
        </Text>
      ) : null}
      {task.output ? (
        <Text style={{ fontFamily: F.regular, fontSize: 13, lineHeight: 18, color: c.foreground }}>{task.output}</Text>
      ) : null}
      {task.error ? (
        <Text style={{ fontFamily: F.regular, fontSize: 13, color: c.destructive }}>{task.error}</Text>
      ) : null}
      {(task.progress ?? []).slice(-3).map((event, i) => (
        <Text key={`${event.kind ?? 'ev'}-${i}`} style={{ fontFamily: F.regular, fontSize: 12, color: c.mutedForeground }}>
          · {event.title ?? event.kind ?? 'progress'}
        </Text>
      ))}
      {childIds.length > 0 ? (
        <View style={{ gap: 2, marginTop: 2 }}>
          <Text style={{ fontFamily: F.medium, fontSize: 12, color: c.foreground }}>
            Subtasks ({childIds.length}){waitingIds.length > 0 ? ` · waiting on ${waitingIds.length} — other work can continue` : ''}
          </Text>
          {childIds.slice(0, 5).map((childId) => {
            const child = byId.get(childId);
            return (
              <Text key={childId} style={{ fontFamily: F.mono, fontSize: 11, color: c.mutedForeground }} numberOfLines={2}>
                · {child ? `${child.title} (${child.status})` : childId}
              </Text>
            );
          })}
        </View>
      ) : waitingIds.length > 0 ? (
        <Text style={{ fontFamily: F.regular, fontSize: 12, color: c.mutedForeground }}>
          Waiting on {waitingIds.length} child task{waitingIds.length === 1 ? '' : 's'} — other work can continue.
        </Text>
      ) : null}
      {(task.questions ?? []).map((question) => (
        <View key={question.id} style={{ gap: 6, marginTop: 4 }}>
          <Text style={{ fontFamily: F.medium, fontSize: 13, color: c.foreground }}>
            {typeof question.prompt === 'string' ? question.prompt : 'The home needs an answer to continue.'}
          </Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TextInput
              testID={`task-answer-${task.id}-${question.id}`}
              value={answers[`${task.id}:${question.id}`] ?? ''}
              onChangeText={(text) => onAnswerText(question.id, text)}
              editable={canUse}
              placeholder="Your answer"
              placeholderTextColor={c.mutedForeground}
              style={[st.input, { flex: 1, color: c.foreground, backgroundColor: c.background, borderColor: c.border }]}
            />
            <Button testID={`task-send-${task.id}-${question.id}`} label="Send" variant="accent" disabled={!canUse} onPress={() => onAnswer(question.id)} />
          </View>
        </View>
      ))}
      {(task.pendingApprovals ?? []).map((approval) => {
        const summary = summarizeApproval({ ...(approval as Record<string, unknown>), id: approval.id } as Record<string, unknown> & { id: string });
        const detailKey = `${task.id}:${approval.id}`;
        const revealed = !!revealedApprovals[detailKey];
        return (
          <View key={approval.id} style={{ gap: 6, marginTop: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border, paddingTop: 8 }}>
            <Text style={{ fontFamily: F.mono, fontSize: 11, letterSpacing: 0.5, color: c.mutedForeground }}>
              NEEDS REVIEW · {summary.action}
            </Text>
            <Text style={{ fontFamily: F.medium, fontSize: 13, color: c.foreground }}>
              {summary.summary}
            </Text>
            {summary.reason ? (
              <Text style={{ fontFamily: F.regular, fontSize: 12, lineHeight: 17, color: c.foreground }}>
                Why: {summary.reason}
              </Text>
            ) : null}
            {summary.destination ? (
              <Text style={{ fontFamily: F.mono, fontSize: 11, color: c.mutedForeground }} numberOfLines={4}>
                Target: {summary.destination}
              </Text>
            ) : null}
            {summary.destination ? (
              <Text style={{ fontFamily: F.regular, fontSize: 11, color: c.mutedForeground }}>
                Shown for review only — never opened automatically.
              </Text>
            ) : null}
            {summary.selector ? (
              <Text style={{ fontFamily: F.mono, fontSize: 11, color: c.mutedForeground }} numberOfLines={3}>
                Selector: {summary.selector}
              </Text>
            ) : null}
            {summary.steps.length > 0 ? (
              <View style={{ gap: 2 }}>
                {summary.steps.map((step, i) => (
                  <Text key={`${detailKey}-step-${i}`} style={{ fontFamily: F.regular, fontSize: 12, color: c.mutedForeground }} numberOfLines={3}>
                    {i + 1}. {step}
                  </Text>
                ))}
              </View>
            ) : null}
            {summary.expiresAt ? (
              <Text style={{ fontFamily: F.mono, fontSize: 11, color: c.mutedForeground }}>
                Expires: {summary.expiresAt}
              </Text>
            ) : null}
            <Text style={{ fontFamily: F.mono, fontSize: 11, color: c.mutedForeground }} numberOfLines={revealed ? undefined : 4}>
              Args: {summary.argsPreview}
            </Text>
            {summary.hasSensitiveArgs ? (
              <Text style={{ fontFamily: F.regular, fontSize: 11, color: c.mutedForeground }}>
                Sensitive values masked.
              </Text>
            ) : null}
            {summary.argsHash || summary.effectiveCaps ? (
              <Button
                label={revealed ? 'Hide technical details' : 'Show technical details'}
                variant="ghost"
                onPress={() => onToggleApprovalDetail(approval.id)}
              />
            ) : null}
            {revealed ? (
              <View style={{ gap: 2 }}>
                {summary.argsHash ? (
                  <Text style={{ fontFamily: F.mono, fontSize: 10, color: c.mutedForeground }} numberOfLines={2}>
                    args_hash: {summary.argsHash}
                  </Text>
                ) : null}
                {summary.effectiveCaps ? (
                  <Text style={{ fontFamily: F.mono, fontSize: 10, color: c.mutedForeground }} numberOfLines={3}>
                    caps: {summary.effectiveCaps}
                  </Text>
                ) : null}
              </View>
            ) : null}
            <Text style={{ fontFamily: F.regular, fontSize: 11, color: c.mutedForeground }}>
              Review the details above before deciding. Approval ID {approval.id} is sent back exactly as issued.
            </Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Button testID={`task-approve-${task.id}-${approval.id}`} label="Approve" variant="accent" disabled={!canUse} onPress={() => onApprove(approval.id, 'approve')} />
              <Button testID={`task-reject-${task.id}-${approval.id}`} label="Reject" variant="danger" disabled={!canUse} onPress={() => onApprove(approval.id, 'reject')} />
            </View>
          </View>
        );
      })}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 2, flexWrap: 'wrap' }}>
        {!terminal ? (
          <Button label="Cancel" variant="ghost" disabled={!canUse} onPress={onCancel} />
        ) : null}
        <Button label={artifacts ? `Artifacts (${artifacts.length})` : 'Artifacts'} variant="ghost" onPress={onArtifacts} />
        {(artifacts ?? []).map((artifact) => {
          const key = `${task.id}:${artifact?.id ?? ''}`;
          const saved = savedByArtifact[key];
          const busy = busyArtifact === key;
          return (
            <View key={artifact?.id ?? ''} style={{ gap: 6, width: '100%' }}>
              <Button
                label={busy ? 'Saving…' : saved ? `Saved ${saved.name}` : `Save ${typeof artifact?.name === 'string' ? artifact.name : artifact?.id ?? 'file'}`}
                variant="ghost"
                disabled={busy}
                onPress={() => artifact?.id && onDownload(artifact.id)}
              />
              {saved ? (
                <View style={{ gap: 6 }}>
                  <Text style={{ fontFamily: F.regular, fontSize: 12, color: c.mutedForeground }}>
                    {saved.name} · {saved.size} bytes · {Platform.OS === 'web' ? 'downloaded via browser' : 'in device cache'}
                  </Text>
                  {isPreviewableText(saved.name) && previewTextByArtifact[key] ? (
                    <Text style={{ fontFamily: F.mono, fontSize: 12, color: c.foreground }} numberOfLines={12}>
                      {previewTextByArtifact[key]}
                    </Text>
                  ) : null}
                  {isPreviewableText(saved.name) && !previewTextByArtifact[key] ? (
                    <Button label="Preview text" variant="ghost" onPress={() => artifact?.id && onPreviewText(artifact.id)} />
                  ) : null}
                  {isPreviewableImage(saved.name) ? (
                    Platform.OS === 'web' ? (
                      <Text style={{ fontFamily: F.regular, fontSize: 12, color: c.mutedForeground }}>
                        Image saved via browser download; open it from your downloads.
                      </Text>
                    ) : (
                      <Image
                        source={{ uri: saved.fileUri }}
                        style={{ width: '100%', height: 180, borderRadius: 10, backgroundColor: c.card }}
                        contentFit="contain"
                      />
                    )
                  ) : null}
                  {!canPreviewInline(saved.name) ? (
                    <Text style={{ fontFamily: F.regular, fontSize: 12, color: c.mutedForeground }}>
                      Preview is disabled for this type; use Share or Open in the system viewer.
                    </Text>
                  ) : null}
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <Button label="Open" variant="accent" onPress={() => artifact?.id && onOpen(artifact.id)} />
                    <Button label="Share" variant="ghost" onPress={() => artifact?.id && onShare(artifact.id)} />
                  </View>
                </View>
              ) : null}
            </View>
          );
        })}
      </View>
    </Card>
  );
}

const st = StyleSheet.create({
  input: { minHeight: 42, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, fontFamily: F.regular, fontSize: 14 },
});
