import 'server-only';

import { adminClient } from '@/lib/supabase/admin';

/**
 * The action confirmation state machine.
 *
 * A destructive action is not executed on the turn it is asked for. It is
 * parked on the conversation as a pending action, the shopper is asked, and it
 * only runs when their next message is an actual yes.
 *
 * Phase 4 reuses this verbatim for `create_order` and `create_payment` — the
 * shape already carries everything a payment confirmation needs.
 */

export type ActionStatus =
  | 'pending'
  | 'awaiting_confirmation'
  | 'confirmed'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired';

export interface PendingAction {
  action: string;
  /** Validated arguments, captured at the moment the action was proposed. */
  arguments: Record<string, unknown>;
  status: ActionStatus;
  /** What the shopper is agreeing to, in their language. */
  summary: string;
  createdAt: string;
  expiresAt: string;
}

/** A parked action goes stale quickly — a cart can change underneath it. */
export const CONFIRMATION_TTL_MS = 5 * 60 * 1000;

export function buildPendingAction(
  action: string,
  args: Record<string, unknown>,
  summary: string,
): PendingAction {
  const now = Date.now();
  return {
    action,
    arguments: args,
    status: 'awaiting_confirmation',
    summary,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + CONFIRMATION_TTL_MS).toISOString(),
  };
}

export function isExpired(action: PendingAction): boolean {
  return new Date(action.expiresAt).getTime() < Date.now();
}

export async function savePendingAction(
  conversationId: string,
  action: PendingAction | null,
): Promise<void> {
  await adminClient()
    .from('conversations')
    .update({ pending_action: action })
    .eq('id', conversationId);
}

export async function loadPendingAction(
  conversationId: string,
): Promise<PendingAction | null> {
  const { data } = await adminClient()
    .from('conversations')
    .select('pending_action')
    .eq('id', conversationId)
    .maybeSingle();

  const raw = data?.pending_action as PendingAction | null | undefined;
  if (!raw || typeof raw !== 'object' || !raw.action) return null;
  if (raw.status !== 'awaiting_confirmation') return null;

  if (isExpired(raw)) {
    await savePendingAction(conversationId, null);
    return null;
  }
  return raw;
}

/* ------------------------------------------------------- reading the answer */

const AFFIRMATIVE =
  /^\s*(yes|yeah|yep|yup|ya|sure|ok(ay)?|go ahead|do it|please do|confirm(ed)?|affirmative|haan|han|haa|ji|ji haan|thik hai|theek hai|kar do|kardo|karo|bilkul|proceed)\b/i;

const NEGATIVE =
  /^\s*(no|nope|nah|don'?t|do not|cancel|stop|wait|never ?mind|leave it|nahi|nahin|mat|rehne do|rahne do|abort)\b/i;

/**
 * Read a reply to a confirmation question.
 *
 * Deliberately strict: only a clear yes counts as a yes. Anything else — a new
 * question, a change of subject, silence about the action — is treated as "not
 * an answer" and the pending action stays parked rather than firing.
 */
export function readConfirmation(message: string): 'yes' | 'no' | 'unclear' {
  const trimmed = message.trim();

  if (NEGATIVE.test(trimmed)) return 'no';
  if (AFFIRMATIVE.test(trimmed)) return 'yes';

  // A yes buried mid-sentence still counts when the sentence is short and
  // contains nothing that looks like a new request.
  if (trimmed.length <= 40 && /\b(yes|haan|confirm|go ahead|do it)\b/i.test(trimmed)) {
    return 'yes';
  }
  if (trimmed.length <= 40 && /\b(no|nahi|cancel|don'?t)\b/i.test(trimmed)) {
    return 'no';
  }

  return 'unclear';
}

/** True when the message is asking for a destructive action in the first place. */
export function looksLikeClearCartRequest(message: string): boolean {
  return /\b(clear|empty|remove everything|remove all|delete everything|delete all|khali kar|saaf kar|sab hata)\b.*\b(cart|basket|order)\b|\b(cart|basket)\b.*\b(clear|empty|khali|saaf)\b/i.test(
    message,
  );
}
