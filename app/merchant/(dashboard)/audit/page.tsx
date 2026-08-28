import type { Metadata } from 'next';
import Link from 'next/link';

import { requireMerchant } from '@/lib/auth';
import { formatPrice } from '@/lib/format';
import { getAuditTrail, type AuditEntry } from '@/lib/analytics/queries';
import { adminClient } from '@/lib/supabase/admin';

export const metadata: Metadata = { title: 'AI Commerce Audit · ShopiQ Merchant' };
export const dynamic = 'force-dynamic';

/**
 * The AI commerce audit trail.
 *
 * This is the page that makes the safety model legible: for any conversation
 * you can see exactly what the assistant understood, which tools it was
 * allowed to run, when it asked for confirmation, when the customer gave it,
 * and only then when money moved.
 *
 * It shows STRUCTURED events only — tool names, statuses, timings and amounts.
 * It deliberately does not show, and cannot show, model reasoning: none is
 * recorded anywhere, which is why "explainable" here means an auditable chain
 * of decisions rather than a narrated one.
 */

/** Money events get their own treatment — they are the ones that matter. */
const MONEY_LABEL: Record<string, string> = {
  checkout_prepared: 'Checkout prepared',
  price_validated: 'Prices re-validated',
  inventory_validated: 'Inventory re-validated',
  confirmation_requested: 'Confirmation requested',
  confirmation_granted: 'Customer confirmed',
  confirmation_expired: 'Confirmation expired',
  confirmation_invalidated: 'Confirmation invalidated',
  confirmation_cancelled: 'Customer cancelled',
  confirmation_consumed: 'Confirmation consumed',
  provider_order_created: 'Razorpay order created',
  payment_initiated: 'Payment initiated',
  payment_callback_received: 'Payment callback received',
  payment_verified: 'Payment verified server-side',
  payment_verification_failed: 'Verification failed',
  payment_failed: 'Payment failed',
  payment_cancelled: 'Payment cancelled',
  webhook_received: 'Webhook received',
  webhook_duplicate: 'Duplicate webhook ignored',
  webhook_rejected: 'Webhook rejected',
  order_created: 'Order created',
  inventory_finalized: 'Inventory finalized',
  cart_cleared: 'Cart cleared',
  finalization_failed: 'Finalization failed',
};

const VOICE_LABEL: Record<string, string> = {
  stt_started: 'Speech recognition started',
  stt_completed: 'Speech recognised',
  stt_failed: 'Speech recognition failed',
  tts_started: 'Speech synthesis started',
  tts_completed: 'Reply spoken',
  tts_failed: 'Speech synthesis failed',
};

function labelFor(entry: AuditEntry): string {
  if (entry.kind === 'money') return MONEY_LABEL[entry.event] ?? entry.event;
  if (entry.kind === 'voice') return VOICE_LABEL[entry.event] ?? entry.event;
  return `${entry.event}()`;
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ conversation?: string; order?: string; customer?: string }>;
}) {
  await requireMerchant();
  const params = await searchParams;

  const db = adminClient();

  // Recent conversations to pick from, so the page is usable without knowing
  // an id by heart.
  const { data: recent } = await db
    .from('conversations')
    .select('id, title, created_at')
    .order('created_at', { ascending: false })
    .limit(12);

  const selectedConversation = params.conversation ?? recent?.[0]?.id ?? null;

  const entries = selectedConversation || params.order || params.customer
    ? await getAuditTrail({
        conversationId: params.order || params.customer ? null : selectedConversation,
        orderId: params.order ?? null,
        customerId: params.customer ?? null,
        limit: 200,
      })
    : [];

  const moneyCount = entries.filter((e) => e.kind === 'money').length;
  const toolCount = entries.filter((e) => e.kind === 'tool').length;
  const voiceCount = entries.filter((e) => e.kind === 'voice').length;

  return (
    <div className="space-y-6">
      <header className="space-y-1.5">
        <h1 className="text-[26px] font-semibold tracking-tight text-white">AI Commerce Audit</h1>
        <p className="max-w-2xl text-[13.5px] leading-relaxed text-[#8A8A93]">
          Every tool the assistant ran and every money action it requested, in order. Structured
          events only — ShopiQ records what was decided and acted on, never model reasoning.
        </p>
      </header>

      {/* --------------------------------------------------------- filters */}
      <section className="rounded-[16px] border border-white/8 bg-[#0C0C0F] p-4">
        <div className="mb-2 text-[11px] uppercase tracking-wide text-[#7E7E88]">Conversation</div>
        <div className="flex flex-wrap gap-2">
          {(recent ?? []).length === 0 ? (
            <p className="text-[13px] text-[#8A8A93]">No conversations recorded yet.</p>
          ) : null}
          {(recent ?? []).map((conversation) => {
            const active = conversation.id === selectedConversation && !params.order;
            return (
              <Link
                key={conversation.id}
                href={`/merchant/audit?conversation=${conversation.id}`}
                className={[
                  'inline-flex max-w-[240px] items-center truncate rounded-full border px-3 py-1.5 text-[12px] transition-colors',
                  active
                    ? 'border-[rgba(247,147,30,.5)] bg-[rgba(247,147,30,.1)] text-[#F7931E]'
                    : 'border-white/10 text-[#C6C6CC] hover:border-white/25 hover:text-white',
                ].join(' ')}
              >
                {conversation.title?.slice(0, 40) || conversation.id.slice(0, 8)}
              </Link>
            );
          })}
        </div>
      </section>

      {/* ---------------------------------------------------------- counts */}
      {entries.length > 0 ? (
        <div className="flex flex-wrap gap-2 text-[12px]">
          <span className="rounded-full border border-white/10 px-3 py-1 text-[#C6C6CC]">
            {toolCount} tool {toolCount === 1 ? 'call' : 'calls'}
          </span>
          <span className="rounded-full border border-[rgba(247,147,30,.35)] bg-[rgba(247,147,30,.08)] px-3 py-1 text-[#F7931E]">
            {moneyCount} money {moneyCount === 1 ? 'event' : 'events'}
          </span>
          {voiceCount > 0 ? (
            <span className="rounded-full border border-white/10 px-3 py-1 text-[#C6C6CC]">
              {voiceCount} voice {voiceCount === 1 ? 'event' : 'events'}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* ----------------------------------------------------------- trail */}
      <section className="rounded-[16px] border border-white/8 bg-[#0C0C0F] p-5">
        {entries.length === 0 ? (
          <p className="py-6 text-center text-[13px] text-[#8A8A93]">
            No audit events for this selection yet.
          </p>
        ) : (
          <ol className="relative space-y-0">
            {entries.map((entry, index) => {
              const isMoney = entry.kind === 'money';
              const isFailure =
                entry.status === 'error' ||
                entry.status === 'rejected' ||
                /failed|rejected|cancelled|expired|invalidated/.test(entry.event);

              return (
                <li key={`${entry.at}-${index}`} className="relative flex gap-4 pb-5 last:pb-0">
                  {/* rail */}
                  <div className="flex flex-col items-center">
                    <span
                      className={[
                        'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                        isFailure
                          ? 'bg-[#FF6B6B]'
                          : isMoney
                            ? 'bg-[#F7931E]'
                            : 'bg-white/25',
                      ].join(' ')}
                    />
                    {index < entries.length - 1 ? (
                      <span className="mt-1 w-px flex-1 bg-white/8" />
                    ) : null}
                  </div>

                  <div className="min-w-0 flex-1 pb-1">
                    <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                      <time className="font-mono text-[11.5px] text-[#7E7E88]">
                        {timeOf(entry.at)}
                      </time>
                      <span
                        className={[
                          'text-[13.5px] font-medium',
                          isFailure ? 'text-[#FF8B8B]' : isMoney ? 'text-[#F7931E]' : 'text-white',
                        ].join(' ')}
                      >
                        {labelFor(entry)}
                      </span>
                      {entry.amount !== null ? (
                        <span className="text-[13px] font-semibold text-white">
                          {formatPrice(entry.amount)}
                        </span>
                      ) : null}
                      {entry.durationMs !== null ? (
                        <span className="text-[11.5px] text-[#6E6E76]">{entry.durationMs} ms</span>
                      ) : null}
                    </div>
                    {entry.detail ? (
                      <p className="mt-1 truncate font-mono text-[11.5px] text-[#6E6E76]">
                        {entry.detail}
                      </p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <p className="text-[12px] leading-relaxed text-[#6E6E76]">
        <strong className="text-[#8A8A93]">What you are looking at.</strong> Tool calls come from{' '}
        <code className="text-[#8A8A93]">ai_tool_logs</code>, money actions from{' '}
        <code className="text-[#8A8A93]">payment_events</code>. Both have row-level security enabled
        with no customer policy, so no shopper can read or alter their own trail — this page reads
        them through the merchant-guarded server role. Amounts shown are the server-computed ones
        that were actually authorised.
      </p>
    </div>
  );
}
