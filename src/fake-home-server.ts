// In-memory fake home service for unit/fixture tests ONLY.
// This is a test double, not a server implementation: it emulates the H1/H2
// `home-api-v1` contract shapes (pair/sessions/conversations/messages with
// `request_key` idempotency, tasks/inputs/approvals/artifacts, and
// `{error:{code,message}}` failures) so client behavior can be verified
// without H1 running. Live verification against real services lives in
// test/real-services.test.mjs.

import { CONTRACT_VERSION } from './home-api-v1.ts';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface InvitationRecord {
  invitationId: string;
  pairingSecret: string;
  installationId: string;
  userId: string;
  expiresAt: number;
  consumed: boolean;
}

interface DeviceRecord {
  deviceId: string;
  label: string;
  userId: string;
  deviceSecret: string;
  revoked: boolean;
  sessionToken: string | null;
  sessionExpiresAt: number | null;
}

interface StoredMessage {
  id: string;
  conversation_id: string;
  author_user_id: string;
  author_device_id: string;
  role: 'user';
  body: string;
  request_key: string | null;
  created_at: number;
}

interface ConversationRecord {
  id: string;
  owner_id: string;
  title: string;
  created_at: number;
  updated_at: number;
  messages: StoredMessage[];
}

interface FakeTask {
  id: string;
  conversation_id: string;
  owner_id: string;
  title: string;
  status: string;
  output?: string;
  error?: string;
  questions?: Array<{ id: string; prompt: string }>;
  pending_approvals?: Array<{ id: string }>;
  progress: Array<{ kind: string; title: string }>;
  artifacts: Array<{ id: string; name: string }>;
  created_at: number;
  updated_at: number;
}

interface FakePushBinding {
  deviceId: string;
  userId: string;
  tokenSuffix: string;
  provider: string;
  permissionEnabled: boolean;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

const EXPO_TOKEN_RE =
  /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9\-_]{1,128}\]$/;

export interface FakeHomeOptions {
  installationId?: string;
  now?: () => number;
}

export class FakeHomeServer {
  readonly installationId: string;
  readonly baseUrl = 'https://home.invalid';
  readonly contractVersion = CONTRACT_VERSION;
  private readonly now: () => number;
  private invitations = new Map<string, InvitationRecord>();
  private devices = new Map<string, DeviceRecord>();
  private sessions = new Map<string, string>();
  private conversations = new Map<string, ConversationRecord>();
  private requestKeys = new Map<string, StoredMessage>();
  private tasks = new Map<string, FakeTask>();
  private pushBindings = new Map<string, FakePushBinding>();
  /** Operator opt-in for push (default enabled in the fake; tests can disable). */
  notificationsEnabled = true;
  private counter = 0;

  constructor(options: FakeHomeOptions = {}) {
    this.installationId = options.installationId ?? 'install_fixture_1';
    this.now = options.now ?? Date.now;
  }

  // -- fixture setup --

  issueInvitation(input: {
    invitationId: string;
    pairingSecret: string;
    userId: string;
    ttlMs?: number;
  }): void {
    this.invitations.set(input.invitationId, {
      invitationId: input.invitationId,
      pairingSecret: input.pairingSecret,
      installationId: this.installationId,
      userId: input.userId,
      expiresAt: this.now() + (input.ttlMs ?? 15 * 60_000),
      consumed: false,
    });
  }

  seedConversation(input: {
    id: string;
    ownerUserId: string;
    title?: string;
  }): void {
    this.conversations.set(input.id, {
      id: input.id,
      owner_id: input.ownerUserId,
      title: input.title ?? 'Fixture conversation',
      created_at: this.now(),
      updated_at: this.now(),
      messages: [],
    });
  }

  /** Seed a task already waiting on a question (for input/approval flows).
   * Approval IDs are namespaced per task like the real H3
   * (`${taskId}:${runtimeId}`) — clients must use the server IDs opaquely. */
  seedWaitingTask(input: {
    id: string;
    conversationId: string;
    ownerUserId: string;
    questionId?: string;
    approvalRuntimeId?: string;
  }): void {
    const approvalRuntimeId = input.approvalRuntimeId ?? 'a1';
    this.tasks.set(input.id, {
      id: input.id,
      conversation_id: input.conversationId,
      owner_id: input.ownerUserId,
      title: 'Fixture waiting task',
      status: input.approvalRuntimeId ? 'waiting_approval' : 'waiting_input',
      questions: input.approvalRuntimeId
        ? undefined
        : [{ id: input.questionId ?? 'q1', prompt: 'Fixture question?' }],
      pending_approvals: input.approvalRuntimeId
        ? [{ id: `${input.id}:${approvalRuntimeId}` }]
        : undefined,
      progress: [{ kind: 'started', title: 'Task started' }],
      artifacts: [],
      created_at: this.now(),
      updated_at: this.now(),
    });
  }

  revokeDevice(deviceId: string): void {
    const device = this.devices.get(deviceId);
    if (!device) return;
    device.revoked = true;
    if (device.sessionToken) this.sessions.delete(device.sessionToken);
    device.sessionToken = null;
    // Revocation disables push delivery immediately (H7).
    this.pushBindings.delete(deviceId);
  }

  /** Simulate a home restart: sessions drop, data + enrollments persist. */
  restart(): void {
    this.sessions.clear();
    for (const device of this.devices.values()) {
      device.sessionToken = null;
    }
  }

  deviceCount(): number {
    return this.devices.size;
  }

  deviceIds(): string[] {
    return [...this.devices.keys()];
  }

  // -- fetch-compatible handler --

  async fetch(
    input: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      body?: string | Uint8Array;
    } = {},
  ): Promise<{ status: number; url: string; json(): Promise<unknown> }> {
    const url = new URL(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = init.headers ?? {};
    const body =
      typeof init.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;

    const ok = (payload: unknown, status = 200) => ({
      status,
      url: input,
      json: async () => payload,
    });
    const fail = (status: number, code: string, message: string) =>
      ok({ error: { code, message } }, status);

    if (url.pathname === '/healthz' && method === 'GET') {
      return ok({
        status: 'ok',
        installation_id: this.installationId,
        contract: this.contractVersion,
      });
    }
    if (url.pathname === '/readyz' && method === 'GET') {
      return ok({ ready: true, installation_id: this.installationId });
    }

    if (url.pathname === '/v1/pair' && method === 'POST') {
      return this.handlePair(body, ok, fail);
    }
    if (url.pathname === '/v1/sessions' && method === 'POST') {
      return this.handleSessions(body, ok, fail);
    }

    const device = this.deviceFromSession(headers);
    if (!device) {
      return fail(401, 'unauthorized', 'Missing or invalid session token.');
    }

    if (url.pathname === '/v1/me' && method === 'GET') {
      return ok({
        user_id: device.userId,
        device_id: device.deviceId,
        installation_id: this.installationId,
      });
    }

    // H7 push registration (device-me, metadata-only, fake provider only).
    if (url.pathname === '/v1/notifications/register' && method === 'POST') {
      if (!this.notificationsEnabled) {
        return fail(403, 'notifications_disabled', 'Push notifications are disabled on this home.');
      }
      for (const owned of ['user_id', 'device_id', 'installation_id']) {
        if (body?.[owned] !== undefined) {
          return fail(400, 'bad_request', `Field is home-managed: ${owned}.`);
        }
      }
      const token = body?.['expo_push_token'];
      if (
        typeof token !== 'string' ||
        token.length < 20 ||
        token.length > 256 ||
        !EXPO_TOKEN_RE.test(token)
      ) {
        return fail(400, 'invalid_push_token', 'expo_push_token must be a valid Expo push token.');
      }
      const provider = body?.['provider'] ?? 'expo';
      if (provider !== 'expo') {
        return fail(400, 'bad_request', 'Only the expo provider is supported.');
      }
      if (typeof body?.['permission_enabled'] !== 'boolean') {
        return fail(400, 'bad_request', 'permission_enabled must be a boolean.');
      }
      const projectId = body?.['project_id'];
      if (
        projectId !== undefined &&
        (typeof projectId !== 'string' || !projectId.trim() || projectId.length > 128)
      ) {
        return fail(400, 'bad_request', 'project_id must be a non-empty string up to 128 chars.');
      }
      // Same push address on a new paired device retires the old binding.
      for (const [otherId, binding] of [...this.pushBindings.entries()]) {
        if (otherId !== device.deviceId && binding.tokenSuffix === suffixOf(String(token))) {
          this.pushBindings.delete(otherId);
        }
      }
      if (
        [...this.pushBindings.values()].filter(
          (b) => b.userId === device.userId && b.deviceId !== device.deviceId && b.enabled,
        ).length >= 10 &&
        !this.pushBindings.has(device.deviceId)
      ) {
        return ok(
          { error: { code: 'registration_limit', message: 'Too many active push registrations.' } },
          429,
        );
      }
      const enabled = (body?.['permission_enabled'] as boolean) === true;
      const at = this.now();
      this.pushBindings.set(device.deviceId, {
        deviceId: device.deviceId,
        userId: device.userId,
        tokenSuffix: suffixOf(String(token)),
        provider: 'expo',
        permissionEnabled: enabled,
        enabled,
        createdAt: this.pushBindings.get(device.deviceId)?.createdAt ?? at,
        updatedAt: at,
      });
      return ok({
        registered: true,
        enabled,
        provider: 'expo',
        permission_enabled: enabled,
        installation_id: this.installationId,
      });
    }
    if (
      (url.pathname === '/v1/notifications/status' || url.pathname === '/v1/notifications') &&
      method === 'GET'
    ) {
      const binding = this.pushBindings.get(device.deviceId);
      if (!binding || binding.userId !== device.userId) {
        return ok({
          registered: false,
          enabled: false,
          provider: 'expo',
          permission_enabled: false,
          installation_id: this.installationId,
        });
      }
      return ok({
        registered: true,
        enabled: binding.enabled && this.notificationsEnabled,
        provider: binding.provider,
        permission_enabled: binding.permissionEnabled,
        token_suffix: binding.tokenSuffix,
        created_at: binding.createdAt,
        updated_at: binding.updatedAt,
        installation_id: this.installationId,
      });
    }
    if (
      (url.pathname === '/v1/notifications/disable' ||
        url.pathname === '/v1/notifications/unregister') &&
      method === 'POST'
    ) {
      // Mirrors the real home: the binding stays (registered:true) with
      // delivery off (enabled:false). Revocation deletes instead (see
      // revokeDevice). Idempotent.
      const existing = this.pushBindings.get(device.deviceId);
      if (existing) {
        existing.enabled = false;
        existing.permissionEnabled = false;
        existing.updatedAt = this.now();
      }
      return ok({ disabled: true });
    }

    const revokeMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/revoke$/);
    if (revokeMatch && method === 'POST') {
      const targetId = decodeURIComponent(revokeMatch[1]);
      const target = this.devices.get(targetId);
      if (!target || target.userId !== device.userId) {
        return fail(404, 'not_found', 'Device not found.');
      }
      this.revokeDevice(targetId);
      return ok({ revoked: true });
    }

    if (url.pathname === '/v1/conversations' && method === 'GET') {
      const mine = [...this.conversations.values()].filter(
        (c) => c.owner_id === device.userId,
      );
      return ok({
        conversations: mine.map((c) => ({
          id: c.id,
          owner_id: c.owner_id,
          title: c.title,
          created_at: c.created_at,
          updated_at: c.updated_at,
        })),
      });
    }
    if (url.pathname === '/v1/conversations' && method === 'POST') {
      const title =
        typeof body?.['title'] === 'string' && body['title'].trim()
          ? body['title'].trim().slice(0, 120)
          : 'New conversation';
      const id = `conv_${++this.counter}`;
      const record: ConversationRecord = {
        id,
        owner_id: device.userId,
        title,
        created_at: this.now(),
        updated_at: this.now(),
        messages: [],
      };
      this.conversations.set(id, record);
      return ok(
        {
          id,
          owner_id: record.owner_id,
          title,
          created_at: record.created_at,
          updated_at: record.updated_at,
        },
        201,
      );
    }

    const convMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)$/);
    if (convMatch && method === 'GET') {
      const conversation = this.conversations.get(
        decodeURIComponent(convMatch[1]),
      );
      if (!conversation || conversation.owner_id !== device.userId) {
        return fail(404, 'not_found', 'Conversation not found.');
      }
      return ok({
        id: conversation.id,
        owner_id: conversation.owner_id,
        title: conversation.title,
        created_at: conversation.created_at,
        updated_at: conversation.updated_at,
      });
    }

    const tasksMatch = url.pathname.match(
      /^\/v1\/conversations\/([^/]+)\/tasks$/,
    );
    if (tasksMatch) {
      const conversation = this.conversations.get(
        decodeURIComponent(tasksMatch[1]),
      );
      if (!conversation || conversation.owner_id !== device.userId) {
        return fail(404, 'not_found', 'Conversation not found.');
      }
      if (method === 'GET') {
        const tasks = [...this.tasks.values()].filter(
          (t) =>
            t.conversation_id === conversation.id &&
            t.owner_id === device.userId,
        );
        return ok({ tasks: tasks.map((t) => this.taskView(t)) });
      }
      if (method === 'POST') {
        return this.handleTaskSubmit(conversation, body, ok, fail);
      }
    }

    const taskGet = url.pathname.match(/^\/v1\/tasks\/([^/]+)$/);
    if (taskGet && method === 'GET') {
      const task = this.ownedTask(decodeURIComponent(taskGet[1]), device.userId);
      if (!task) return fail(404, 'not_found', 'Task not found.');
      return ok(this.taskView(task));
    }
    const taskCancel = url.pathname.match(/^\/v1\/tasks\/([^/]+)\/cancel$/);
    if (taskCancel && method === 'POST') {
      const task = this.ownedTask(decodeURIComponent(taskCancel[1]), device.userId);
      if (!task) return fail(404, 'not_found', 'Task not found.');
      if (task.status === 'succeeded' || task.status === 'failed' || task.status === 'cancelled') {
        return fail(409, 'wrong_state', 'Task is already terminal.');
      }
      task.status = 'cancelled';
      task.updated_at = this.now();
      return ok(this.taskView(task));
    }
    const taskInputs = url.pathname.match(/^\/v1\/tasks\/([^/]+)\/inputs$/);
    if (taskInputs && method === 'POST') {
      const task = this.ownedTask(decodeURIComponent(taskInputs[1]), device.userId);
      if (!task) return fail(404, 'not_found', 'Task not found.');
      if (task.status !== 'waiting_input') {
        return fail(409, 'wrong_state', 'Task is not waiting for input.');
      }
      const inputs = body?.['inputs'];
      if (!Array.isArray(inputs) || inputs.length === 0) {
        return fail(400, 'bad_request', 'inputs are required.');
      }
      const known = new Set((task.questions ?? []).map((q) => q.id));
      for (const entry of inputs) {
        const record = entry as { id?: unknown; answer?: unknown };
        if (typeof record.id !== 'string' || !known.has(record.id)) {
          return fail(400, 'bad_request', 'Unknown question id.');
        }
        if (typeof record.answer !== 'string' || !record.answer.trim()) {
          return fail(400, 'bad_request', 'Answer text is required.');
        }
      }
      task.status = 'succeeded';
      task.output = `fixture-echo: answered ${(inputs as Array<{ id: string; answer: string }>).map((i) => `${i.id} with ${String(i.answer).slice(0, 200)}`).join(',')}`;
      task.questions = undefined;
      task.updated_at = this.now();
      return ok(this.taskView(task));
    }
    const taskApprovals = url.pathname.match(/^\/v1\/tasks\/([^/]+)\/approvals$/);
    if (taskApprovals && method === 'POST') {
      const task = this.ownedTask(decodeURIComponent(taskApprovals[1]), device.userId);
      if (!task) return fail(404, 'not_found', 'Task not found.');
      if (task.status !== 'waiting_approval') {
        return fail(409, 'wrong_state', 'Task is not waiting for approval.');
      }
      const approvals = body?.['approvals'];
      if (!Array.isArray(approvals) || approvals.length === 0) {
        return fail(400, 'bad_request', 'approvals are required.');
      }
      const decided = (approvals as Array<{ decision?: unknown }>).every(
        (a) => a.decision === 'approve' || a.decision === 'reject',
      );
      if (!decided) return fail(400, 'bad_request', 'Decision must be approve or reject.');
      // Unknown approval IDs are caller bugs (real H3: 400). IDs are opaque
      // server values namespaced per task — a bare runtime id never matches.
      const known = new Set((task.pending_approvals ?? []).map((a) => a.id));
      for (const entry of approvals as Array<{ id?: unknown }>) {
        if (typeof entry.id !== 'string' || !known.has(entry.id)) {
          return fail(400, 'bad_request', 'Unknown approval id.');
        }
      }
      const rejected = (approvals as Array<{ decision?: unknown }>).some(
        (a) => a.decision === 'reject',
      );
      if (rejected) {
        // Matches the real H3 decline path: the run fails honestly with an
        // approval_rejected error and publishes no assistant message.
        task.status = 'failed';
        task.error = 'approval_rejected: approval declined';
      } else {
        task.status = 'succeeded';
        task.output = 'fixture-echo: approved';
      }
      task.pending_approvals = undefined;
      task.updated_at = this.now();
      return ok(this.taskView(task));
    }
    const taskArtifacts = url.pathname.match(/^\/v1\/tasks\/([^/]+)\/artifacts$/);
    if (taskArtifacts && method === 'GET') {
      const task = this.ownedTask(decodeURIComponent(taskArtifacts[1]), device.userId);
      if (!task) return fail(404, 'not_found', 'Task not found.');
      return ok({ artifacts: task.artifacts });
    }

    const messagesMatch = url.pathname.match(
      /^\/v1\/conversations\/([^/]+)\/messages$/,
    );
    if (messagesMatch) {
      const conversation = this.conversations.get(
        decodeURIComponent(messagesMatch[1]),
      );
      if (!conversation || conversation.owner_id !== device.userId) {
        return fail(404, 'not_found', 'Conversation not found.');
      }
      if (method === 'GET') {
        return ok({ messages: conversation.messages });
      }
      if (method === 'POST') {
        return this.handlePostMessage(conversation, device, body, ok, fail);
      }
    }

    return fail(404, 'not_found', 'Unknown route.');
  }

  private ownedTask(taskId: string, userId: string): FakeTask | null {
    const task = this.tasks.get(taskId) ?? null;
    if (!task || task.owner_id !== userId) return null;
    return task;
  }

  private taskView(task: FakeTask): Record<string, unknown> {
    const view: Record<string, unknown> = {
      id: task.id,
      conversation_id: task.conversation_id,
      title: task.title,
      status: task.status,
      created_at: task.created_at,
      updated_at: task.updated_at,
      progress: task.progress,
      artifacts: task.artifacts,
      model: { provider: 'fixture', model: 'fixture-echo' },
    };
    if (task.output !== undefined) view['output'] = task.output;
    if (task.error !== undefined) view['error'] = task.error;
    if (task.questions !== undefined) view['questions'] = task.questions;
    if (task.pending_approvals !== undefined) {
      view['pending_approvals'] = task.pending_approvals;
    }
    return view;
  }

  private deviceFromSession(
    headers: Record<string, string>,
  ): DeviceRecord | null {
    const raw = headers['Authorization'] ?? headers['authorization'] ?? '';
    const match = /^Bearer (.+)$/.exec(raw);
    if (!match) return null;
    const deviceId = this.sessions.get(match[1]);
    if (!deviceId) return null;
    const device = this.devices.get(deviceId) ?? null;
    if (!device || device.revoked) return null;
    return device;
  }

  private handlePair(
    body: Record<string, unknown> | undefined,
    ok: (payload: unknown, status?: number) => {
      status: number;
      url: string;
      json(): Promise<unknown>;
    },
    fail: (status: number, code: string, message: string) => {
      status: number;
      url: string;
      json(): Promise<unknown>;
    },
  ) {
    const invitationId = body?.['invitation_id'];
    const secret = body?.['invitation_secret'];
    const label = body?.['device_label'];
    const installationId = body?.['installation_id'];
    if (
      typeof invitationId !== 'string' ||
      typeof secret !== 'string' ||
      typeof label !== 'string' ||
      !label.trim()
    ) {
      return fail(400, 'bad_request', 'invitation_id, invitation_secret, and device_label are required.');
    }
    if (installationId !== undefined && installationId !== this.installationId) {
      return fail(403, 'wrong_home', 'Invitation targets a different home.');
    }
    const record = this.invitations.get(invitationId);
    if (!record) return fail(404, 'invitation_not_found', 'Unknown invitation.');
    // Atomic consume: at most one device ever enrolls from this invitation.
    if (record.consumed) {
      return fail(410, 'invitation_consumed', 'Invitation already used.');
    }
    if (record.expiresAt <= this.now()) {
      return fail(410, 'invitation_expired', 'Invitation expired.');
    }
    if (record.pairingSecret !== secret) {
      return fail(403, 'invalid_invitation', 'Invalid invitation secret.');
    }
    record.consumed = true;
    const deviceSecret = `devsec_${record.invitationId}_${++this.counter}`;
    const deviceId = `dev_${++this.counter}`;
    this.devices.set(deviceId, {
      deviceId,
      label: label.trim(),
      userId: record.userId,
      deviceSecret,
      revoked: false,
      sessionToken: null,
      sessionExpiresAt: null,
    });
    return ok(
      {
        device_id: deviceId,
        device_secret: deviceSecret,
        user_id: record.userId,
        installation_id: this.installationId,
      },
      201,
    );
  }

  private handleSessions(
    body: Record<string, unknown> | undefined,
    ok: (payload: unknown, status?: number) => {
      status: number;
      url: string;
      json(): Promise<unknown>;
    },
    fail: (status: number, code: string, message: string) => {
      status: number;
      url: string;
      json(): Promise<unknown>;
    },
  ) {
    const deviceId = body?.['device_id'];
    const deviceSecret = body?.['device_secret'];
    const device =
      typeof deviceId === 'string' ? this.devices.get(deviceId) : undefined;
    if (
      !device ||
      device.deviceSecret !== deviceSecret ||
      device.revoked
    ) {
      return fail(401, 'invalid_device', 'Unknown, revoked, or mismatched device credential.');
    }
    const token = `ht1_sess_${++this.counter}`;
    const expiresAt = this.now() + 12 * 60 * 60 * 1000;
    device.sessionToken = token;
    device.sessionExpiresAt = expiresAt;
    this.sessions.set(token, device.deviceId);
    return ok(
      {
        token,
        expires_at: expiresAt,
        user_id: device.userId,
        device_id: device.deviceId,
      },
      201,
    );
  }

  private handleTaskSubmit(
    conversation: ConversationRecord,
    body: Record<string, unknown> | undefined,
    ok: (payload: unknown, status?: number) => {
      status: number;
      url: string;
      json(): Promise<unknown>;
    },
    fail: (status: number, code: string, message: string) => {
      status: number;
      url: string;
      json(): Promise<unknown>;
    },
  ) {
    const request = body?.['request'];
    if (typeof request !== 'string' || !request.trim() || request.length > 8000) {
      return fail(400, 'bad_request', 'request is required (1..8000 chars).');
    }
    if (body?.['model'] !== undefined) {
      return fail(400, 'model_override_denied', 'Model selection is home-managed.');
    }
    const task: FakeTask = {
      id: `task_${++this.counter}`,
      conversation_id: conversation.id,
      owner_id: conversation.owner_id,
      title:
        typeof body?.['title'] === 'string' && body['title'].trim()
          ? String(body['title']).slice(0, 120)
          : request.trim().slice(0, 42),
      status: 'queued',
      progress: [{ kind: 'queued', title: 'Task queued' }],
      artifacts: [],
      created_at: this.now(),
      updated_at: this.now(),
    };
    this.tasks.set(task.id, task);
    return ok(this.taskView(task), 201);
  }

  private handlePostMessage(
    conversation: ConversationRecord,
    device: DeviceRecord,
    body: Record<string, unknown> | undefined,
    ok: (payload: unknown, status?: number) => {
      status: number;
      url: string;
      json(): Promise<unknown>;
    },
    fail: (status: number, code: string, message: string) => {
      status: number;
      url: string;
      json(): Promise<unknown>;
    },
  ) {
    const text = body?.['body'];
    const role = body?.['role'];
    const requestKey = body?.['request_key'];
    if (role !== undefined && role !== 'user') {
      return fail(400, 'unsupported_role', 'Only user messages are accepted.');
    }
    if (typeof text !== 'string' || !text.trim() || text.length > 20_000) {
      return fail(400, 'bad_request', 'Message body is empty or oversize.');
    }
    let key: string | null = null;
    if (requestKey !== undefined) {
      if (typeof requestKey !== 'string' || !UUID_RE.test(requestKey)) {
        return fail(400, 'bad_request', 'request_key must be a UUID.');
      }
      key = requestKey;
      // Keys bind to (conversation, author): scoped lookup.
      const scoped = `${conversation.id}:${device.userId}:${key}`;
      const seen = this.requestKeys.get(scoped);
      if (seen) {
        if (seen.body === text.trim()) {
          return ok({ ...seen, duplicate: true }, 200);
        }
        return fail(
          409,
          'request_key_conflict',
          'request_key was already used with different content.',
        );
      }
    }
    const message: StoredMessage = {
      id: `msg_${++this.counter}`,
      conversation_id: conversation.id,
      author_user_id: device.userId,
      author_device_id: device.deviceId,
      role: 'user',
      body: text.trim(),
      request_key: key,
      created_at: this.now(),
    };
    conversation.messages.push(message);
    conversation.updated_at = this.now();
    if (key) {
      this.requestKeys.set(
        `${conversation.id}:${device.userId}:${key}`,
        message,
      );
    }
    return ok({ ...message, duplicate: false }, 201);
  }
}

function suffixOf(token: string): string {
  return token.length <= 8 ? `…${token}` : `…${token.slice(-8)}`;
}
