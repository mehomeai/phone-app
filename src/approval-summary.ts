// Portable approval summarization + task-relationship parsing (pure, zero deps).
//
// F6: approval cards must be reviewable — action/summary/reason,
// destination URL or selector/action sequence, expiry — never a blind
// Approve/Reject pair. The H6 contract is not yet published, so this parses
// defensively: known keys in camelCase and snake_case, unknown shapes fall
// back to safe generic text. Nothing here performs I/O, opens URLs, or
// renders HTML — callers render the returned strings as native Text.
//
// Privacy: sensitive arg values (password/token/secret/auth/...) are masked
// by default. Callers show a bounded masked preview and reveal the full
// (still masked for truly sensitive keys) detail only on explicit user
// action. args_hash / effective_caps are optional technical metadata shown
// only when useful, never required.

export interface ApprovalSummary {
  /** Opaque server-issued approval id (use verbatim in decide calls). */
  id: string;
  /** What the home wants to do (e.g. "browser.open", "file.write"). */
  action: string;
  /** Human-readable one-line summary. */
  summary: string;
  /** Why the home needs approval, when provided. */
  reason?: string;
  /** Destination URL / target, when provided. Never auto-opened. */
  destination?: string;
  /** Element selector / target description, when provided. */
  selector?: string;
  /** Action sequence / plan steps, when provided (bounded). */
  steps: string[];
  /** Expiry label (raw server value rendered as text), when provided. */
  expiresAt?: string;
  /** Bounded masked args preview for the card. */
  argsPreview: string;
  /** True when any arg key looked sensitive (masked in preview). */
  hasSensitiveArgs: boolean;
  /** True when the approval carried an args object at all. */
  hasArgs: boolean;
  /** Optional integrity hash, shown only as technical metadata. */
  argsHash?: string;
  /** Optional effective capability grants, shown only as metadata. */
  effectiveCaps?: string;
}

export interface TaskRelations {
  parentTaskId?: string;
  rootTaskId?: string;
  /** Known child task ids (opaque server ids). */
  childTaskIds: string[];
  /** Subset (or separate list) still waiting — other work can continue. */
  waitingChildren: string[];
}

const SENSITIVE_KEY_RE =
  /password|passwd|secret|token|api[_-]?key|auth|bearer|credential|private[_-]?key|session[_-]?token|cookie/i;

/**
 * R7 browser-fill guard: browser `fill`/`type` actions carry the literal
 * keystrokes (`actions.fill.text`, `text`, `value`, …). Key-name masking is
 * not enough — the VALUES are the secret (passwords, card numbers, session
 * strings). Any browser fill/input/type action therefore masks ALL fill-text
 * values by default, including behind Details. The reviewer still sees the
 * target descriptor (name/type/destination/form action) to decide.
 */
const BROWSER_FILL_ACTION_RE = /browser|fill|input|keystroke|\btype\b/i;
const FILL_TEXT_KEY_RE =
  /^(text|value|fill|fill_text|fillText|input|input_text|inputText|content|typed|typed_text|typedText|keystrokes|characters|string)$/i;

const MAX_ARGS_PREVIEW_CHARS = 500;
const MAX_STEPS = 8;
const MAX_STEP_CHARS = 160;
const MAX_SUMMARY_CHARS = 280;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function firstString(
  obj: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function firstUnknown(
  obj: Record<string, unknown>,
  keys: string[],
): unknown {
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** True when this approval drives a browser fill (keystrokes are secrets). */
export function isBrowserFillAction(action: string): boolean {
  return BROWSER_FILL_ACTION_RE.test(action ?? '');
}

/**
 * Mask an approval args tree for display. Sensitive key names are always
 * masked; browser-fill text VALUES are additionally masked for fill/input
 * actions (passwords/type-ins stay masked even behind Details).
 */
export function maskApprovalArgs(action: string, args: unknown): unknown {
  const masked = maskSensitiveValue(null, args);
  if (!isBrowserFillAction(action)) return masked;
  return maskFillTextValues(masked);
}

function maskFillTextValues(value: unknown, depth = 0): unknown {
  if (depth > 5) return '…';
  if (Array.isArray(value)) {
    return value
      .slice(0, 20)
      .map((entry) => maskFillTextValues(entry, depth + 1));
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value).slice(0, 40)) {
      if (FILL_TEXT_KEY_RE.test(k) && typeof v === 'string' && v) {
        out[k] = '•••masked•••';
      } else {
        out[k] = maskFillTextValues(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

/** Mask sensitive keys recursively; non-sensitive leaves pass through. */
export function maskSensitiveValue(
  key: string | null,
  value: unknown,
  depth = 0,
): unknown {
  if (depth > 4) return '…';
  if (key && SENSITIVE_KEY_RE.test(key)) {
    if (value === undefined || value === null || value === '') return value;
    return '•••masked•••';
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 20)
      .map((entry) => maskSensitiveValue(null, entry, depth + 1));
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value).slice(0, 40)) {
      out[k] = maskSensitiveValue(k, v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 500) {
    return `${value.slice(0, 499)}…`;
  }
  return value;
}

function containsSensitiveKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSensitiveKey);
  if (isRecord(value)) {
    return Object.entries(value).some(
      ([k, v]) => SENSITIVE_KEY_RE.test(k) || containsSensitiveKey(v),
    );
  }
  return false;
}

/**
 * R7 target descriptor: surface name/type/inputType/destination/formAction
 * for review (never auto-opened). Looks inside args for a descriptor object
 * (`target_descriptor` / `targetDescriptor` / `target` / `element`) and
 * returns a review label like `password field "Current password"`.
 */
export function describeApprovalTarget(args: unknown): string | undefined {
  const record = drillForDescriptor(args);
  if (!record) return undefined;
  const name =
    firstString(record, ['name', 'label', 'field', 'placeholder', 'aria_label', 'ariaLabel']);
  const type =
    firstString(record, ['inputType', 'input_type', 'type', 'kind', 'role']);
  const formAction =
    firstString(record, ['form_action', 'formAction', 'form', 'action']);
  const dest =
    firstString(record, ['destination_url', 'destinationUrl', 'url', 'target_url', 'targetUrl']);
  const bits: string[] = [];
  if (type) bits.push(type);
  if (name) bits.push(`"${name.slice(0, 80)}"`);
  let label = bits.length > 0 ? bits.join(' ') : undefined;
  if (formAction) label = label ? `${label} · form ${formAction.slice(0, 120)}` : `form ${formAction.slice(0, 120)}`;
  if (dest) label = label ? `${label} · ${dest.slice(0, 160)}` : dest.slice(0, 160);
  return label?.slice(0, 280);
}

function drillForDescriptor(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) {
    if (Array.isArray(value)) {
      for (const entry of value.slice(0, 5)) {
        const found = drillForDescriptor(entry);
        if (found) return found;
      }
    }
    return null;
  }
  const direct =
    (isRecord(value['target_descriptor']) ? (value['target_descriptor'] as Record<string, unknown>) : null) ??
    (isRecord(value['targetDescriptor']) ? (value['targetDescriptor'] as Record<string, unknown>) : null) ??
    (isRecord(value['target']) && typeof (value['target'] as Record<string, unknown>)['inputType'] === 'string'
      ? (value['target'] as Record<string, unknown>)
      : null) ??
    (isRecord(value['element']) ? (value['element'] as Record<string, unknown>) : null) ??
    (isRecord(value['descriptor']) ? (value['descriptor'] as Record<string, unknown>) : null);
  if (direct) return direct;
  // The args object itself may BE the descriptor (inputType at top level).
  if (
    typeof value['inputType'] === 'string' ||
    typeof value['input_type'] === 'string' ||
    (typeof value['type'] === 'string' && typeof value['name'] === 'string')
  ) {
    return value;
  }
  for (const nestedKey of ['actions', 'fill', 'target_descriptor', 'targetDescriptor', 'details']) {
    const nested = value[nestedKey];
    if (nested !== undefined) {
      const found = drillForDescriptor(nested);
      if (found) return found;
    }
  }
  return null;
}

function stepsFromUnknown(value: unknown): string[] {
  if (!Array.isArray(value)) {
    if (typeof value === 'string' && value.trim()) {
      return [truncate(value.trim(), MAX_STEP_CHARS)];
    }
    return [];
  }
  const out: string[] = [];
  for (const entry of value.slice(0, MAX_STEPS)) {
    if (typeof entry === 'string' && entry.trim()) {
      out.push(truncate(entry.trim(), MAX_STEP_CHARS));
    } else if (isRecord(entry)) {
      const label =
        firstString(entry, [
          'title',
          'label',
          'action',
          'op',
          'kind',
          'type',
          'summary',
          'description',
        ]) ?? JSON.stringify(maskSensitiveValue(null, entry));
      out.push(truncate(label, MAX_STEP_CHARS));
    } else if (entry !== undefined && entry !== null) {
      out.push(truncate(String(entry), MAX_STEP_CHARS));
    }
  }
  return out;
}

function stringListFromUnknown(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim()) out.push(entry.trim());
    else if (isRecord(entry) && typeof entry['id'] === 'string' && entry['id'].trim()) {
      out.push(entry['id'].trim());
    }
  }
  return out;
}

function formatExpiry(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    try {
      // Heuristic: seconds vs millis.
      const millis = value < 1e12 ? value * 1000 : value;
      return new Date(millis).toISOString();
    } catch {
      return String(value);
    }
  }
  return undefined;
}

/**
 * Build a reviewable, privacy-safe summary for one pending approval.
 * Unknown shapes never throw: they fall back to a generic summary that
 * still forces an explicit review (no blind approve).
 */
export function summarizeApproval(
  approval: Record<string, unknown> & { id: string },
): ApprovalSummary {
  const id = approval.id;
  const action =
    firstString(approval, [
      'action',
      'operation',
      'op',
      'kind',
      'type',
      'tool',
      'capability',
      'title',
    ]) ?? 'Approval requested';
  const summaryRaw =
    firstString(approval, [
      'summary',
      'description',
      'prompt',
      'message',
      'label',
      'title',
      'reason',
    ]) ?? 'The home is asking to proceed. Review the details before deciding.';
  const reason = firstString(approval, [
    'reason',
    'rationale',
    'justification',
    'why',
    'explanation',
  ]);
  const destination = firstString(approval, [
    'destination_url',
    'destinationUrl',
    'url',
    'target_url',
    'targetUrl',
    'target',
    'endpoint',
    'destination',
    'href',
  ]);
  const selector = firstString(approval, [
    'selector',
    'css_selector',
    'cssSelector',
    'xpath',
    'element',
    'target_selector',
    'targetSelector',
  ]);
  const steps = stepsFromUnknown(
    firstUnknown(approval, [
      'steps',
      'actions',
      'sequence',
      'plan',
      'commands',
      'operations',
    ]),
  );
  const expiresAt = formatExpiry(
    firstUnknown(approval, [
      'expires_at',
      'expiresAt',
      'expires',
      'deadline',
      'valid_until',
      'validUntil',
    ]),
  );
  const rawArgs = firstUnknown(approval, [
    'args',
    'arguments',
    'params',
    'parameters',
    'input',
    'payload',
    'options',
    'details',
  ]);
  const hasArgs = rawArgs !== undefined;
  const hasSensitiveArgs =
    hasArgs && (containsSensitiveKey(rawArgs) || isBrowserFillAction(action));
  let argsPreview = 'No arguments provided.';
  if (hasArgs) {
    try {
      // Browser fill text is always masked (R7); sensitive keys always masked.
      const masked = maskApprovalArgs(action, rawArgs);
      const text =
        typeof masked === 'string' ? masked : JSON.stringify(masked);
      argsPreview = truncate(text ?? '', MAX_ARGS_PREVIEW_CHARS);
      if (!argsPreview) argsPreview = 'Arguments provided (empty).';
    } catch {
      argsPreview = 'Arguments provided (could not be displayed safely).';
    }
  }
  // R7: always show the fill target for review even when values are masked.
  const targetLabel = hasArgs ? describeApprovalTarget(rawArgs) : undefined;
  const argsHash = firstString(approval, [
    'args_hash',
    'argsHash',
    'params_hash',
    'paramsHash',
  ]);
  const capsRaw = firstUnknown(approval, [
    'effective_caps',
    'effectiveCaps',
    'capabilities',
    'caps',
    'grants',
  ]);
  let effectiveCaps: string | undefined;
  if (Array.isArray(capsRaw)) {
    const list = capsRaw
      .map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry)))
      .filter(Boolean)
      .slice(0, 10);
    if (list.length > 0) effectiveCaps = list.join(', ');
  } else if (typeof capsRaw === 'string' && capsRaw.trim()) {
    effectiveCaps = truncate(capsRaw.trim(), 200);
  } else if (isRecord(capsRaw)) {
    try {
      effectiveCaps = truncate(JSON.stringify(capsRaw), 200);
    } catch {
      effectiveCaps = undefined;
    }
  }
  // Prefer the explicit target descriptor for the review line; fall back to
  // the legacy destination/selector fields.
  const reviewDestination = destination ?? targetLabel;
  return {
    id,
    action,
    summary: truncate(summaryRaw, MAX_SUMMARY_CHARS),
    ...(reason ? { reason: truncate(reason, MAX_SUMMARY_CHARS) } : {}),
    ...(reviewDestination ? { destination: truncate(reviewDestination, 300) } : {}),
    ...(selector ? { selector: truncate(selector, 200) } : {}),
    steps,
    ...(expiresAt ? { expiresAt } : {}),
    argsPreview,
    hasSensitiveArgs,
    hasArgs,
    ...(argsHash ? { argsHash: truncate(argsHash, 120) } : {}),
    ...(effectiveCaps ? { effectiveCaps } : {}),
  };
}

/**
 * Parse optional task-relationship fields compatibly (camelCase + snake_case).
 * Unknown fields are ignored; malformed lists fall back to empty (no crash,
 * no invented children).
 */
export function parseTaskRelations(
  view: Record<string, unknown>,
): TaskRelations {
  const parentTaskId = firstString(view, [
    'parent_task_id',
    'parentTaskId',
    'parent_id',
    'parentId',
  ]);
  const rootTaskId = firstString(view, [
    'root_task_id',
    'rootTaskId',
    'root_id',
    'rootId',
  ]);
  const childTaskIds = stringListFromUnknown(
    firstUnknown(view, [
      'child_task_ids',
      'childTaskIds',
      'children',
      'child_ids',
      'childIds',
      'subtasks',
    ]),
  ).slice(0, 50);
  const waitingChildren = stringListFromUnknown(
    firstUnknown(view, [
      'waiting_children',
      'waitingChildren',
      'waiting_child_ids',
      'waitingChildIds',
      'blocked_on',
      'blockedOn',
    ]),
  ).slice(0, 50);
  return {
    ...(parentTaskId ? { parentTaskId } : {}),
    ...(rootTaskId ? { rootTaskId } : {}),
    childTaskIds,
    waitingChildren,
  };
}
