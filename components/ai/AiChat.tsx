'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';

import { AlertIcon, SparkIcon, SpinnerIcon, StarIcon } from '@/components/ui/icons';
import { cx, formatPrice } from '@/lib/format';
import type {
  AgentAction,
  AgentCartPayload,
  AgentCheckoutPayload,
  AgentPaymentPayload,
  AgentPurchasePayload,
  ComparisonPayload,
  RecommendedProductPayload,
} from '@/lib/ai/types';
import { AiCartCard, AiCheckoutCard, AiConfirmCard } from './AiCartCard';
import {
  AiOrderConfirmedCard,
  AiPaymentFailedCard,
  AiPaymentStatus,
  AiPurchaseCard,
  AiTotalChangedCard,
  type PaymentPhase,
} from './AiPaymentCard';
import { launchPayment } from '@/lib/payments/checkout-client';
import { VoiceControl } from '@/components/voice/VoiceControl';
import { useVoiceSession } from '@/lib/voice/use-voice-session';
import { useCart } from '@/components/cart/CartProvider';

/**
 * The ShopiQ conversation.
 *
 * Every product fact rendered here comes from the API response, which in turn
 * comes from the catalogue — the component never derives or infers a price,
 * a spec or a stock figure of its own.
 */

interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  products?: RecommendedProductPayload[];
  comparison?: ComparisonPayload | null;
  actions?: AgentAction[];
  outcome?: string;
  degraded?: boolean;
  cart?: AgentCartPayload | null;
  checkout?: AgentCheckoutPayload | null;
  pendingAction?: { action: string; summary: string } | null;
  /** Phase 4 — an exact total awaiting approval, and how its payment went. */
  purchase?: AgentPurchasePayload | null;
  payment?: AgentPaymentPayload | null;
  paymentPhase?: PaymentPhase;
  paymentMessage?: string | null;
  order?: { id: string; orderNumber: string; totalDisplay: string } | null;
  totalChanged?: { oldDisplay: string; newDisplay: string; reason: string } | null;
}

interface ChatResponse {
  conversationId: string;
  message: string;
  products: RecommendedProductPayload[];
  comparison: ComparisonPayload | null;
  actions: AgentAction[];
  outcome?: string;
  degraded?: boolean;
  cart?: AgentCartPayload | null;
  checkout?: AgentCheckoutPayload | null;
  pendingAction?: { action: string; summary: string } | null;
  purchase?: AgentPurchasePayload | null;
  payment?: AgentPaymentPayload | null;
  order?: { id: string; orderNumber: string; totalDisplay: string } | null;
  /** Server-derived label for which payload this turn carries. */
  type?: string;
  /** The short line to speak, when the turn arrived by voice. */
  speech?: string | null;
  error?: { code: string; message: string };
}

const SUGGESTIONS = [
  'A laptop for programming and gaming under ₹80,000',
  'Wireless earbuds under ₹3,000 for the gym',
  'Mujhe 50 hazaar ke andar ek phone chahiye',
];

export function AiChat({ seedMessage }: { seedMessage?: string | null }) {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState('');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiEnabled, setAiEnabled] = useState<boolean | null>(null);

  const { refresh: refreshCart, addItem } = useCart();

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const seededRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/ai/status', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (!cancelled && payload) setAiEnabled(Boolean(payload.aiEnabled));
      })
      .catch(() => {
        if (!cancelled) setAiEnabled(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns, pending]);

  const send = useCallback(
    async (
      text: string,
      origin: { inputMode?: 'text' | 'voice'; language?: string | null } = {},
    ) => {
      const trimmed = text.trim();
      if (!trimmed || pending) return;

      setError(null);
      setInput('');
      setTurns((current) => [
        ...current,
        { id: `u-${Date.now()}`, role: 'user', content: trimmed },
      ]);
      setPending(true);

      try {
        const response = await fetch('/api/ai/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // input_mode is a label on the turn, not a branch: the agent, the
          // tools and the payment gate all behave identically either way.
          body: JSON.stringify({
            conversationId,
            message: trimmed,
            inputMode: origin.inputMode ?? 'text',
            ...(origin.language ? { language: origin.language } : {}),
          }),
        });

        const payload = (await response.json().catch(() => null)) as ChatResponse | null;

        if (!response.ok || payload?.error) {
          setError(
            payload?.error?.message ??
              'ShopiQ AI could not answer that just now. You can keep browsing normally.',
          );
          setPending(false);
          return;
        }
        if (!payload) {
          setError('ShopiQ AI returned an unexpected response.');
          setPending(false);
          return;
        }

        setConversationId(payload.conversationId);
        setTurns((current) => [
          ...current,
          {
            id: `a-${Date.now()}`,
            role: 'assistant',
            content: payload.message,
            products: payload.products,
            comparison: payload.comparison,
            actions: payload.actions,
            outcome: payload.outcome,
            degraded: payload.degraded,
            cart: payload.cart ?? null,
            checkout: payload.checkout ?? null,
            pendingAction: payload.pendingAction ?? null,
            purchase: payload.purchase ?? null,
            payment: payload.payment ?? null,
            paymentPhase: payload.payment ? 'ready' : 'idle',
            order: payload.order ?? null,
          },
        ]);

        // The website header badge and the /cart page read from the same
        // cart, so a change made through the assistant has to refresh them.
        if (payload.cart) void refreshCart();

        // Speak the short form, not the whole card. The screen already has the
        // detail; reading a product grid aloud is unbearable. Only a turn that
        // arrived by voice gets spoken back.
        if (origin.inputMode === 'voice' && payload.speech) {
          void voiceRef.current?.speak(payload.speech, origin.language ?? null);
        }
      } catch {
        setError(
          'Could not reach ShopiQ AI. Check your connection — the rest of the store still works.',
        );
      } finally {
        setPending(false);
        inputRef.current?.focus();
      }
    },
    [conversationId, pending, refreshCart],
  );

  // A prompt chip on the product page opens the panel with a question ready.
  useEffect(() => {
    if (seedMessage && !seededRef.current) {
      seededRef.current = true;
      void send(seedMessage);
    }
  }, [seedMessage, send]);

  const compare = (productIds: string[]) => {
    void send(`Compare ${productIds.length} of these products for me.`);
  };

  /**
   * The card's Add to Cart button goes through the same /api/cart/items route
   * the website uses, then tells the assistant so the conversation stays in
   * step with what the shopper just did.
   */
  const addToCart = async (productId: string, name: string) => {
    const ok = await addItem(productId, 1);
    if (ok) {
      await refreshCart();
      void send(`I added the ${name} to my cart.`);
    }
  };

  // A ref breaks the circular dependency: send() needs to speak the reply,
  // and the voice session needs send() to submit a transcript.
  const voiceRef = useRef<ReturnType<typeof useVoiceSession> | null>(null);

  const voice = useVoiceSession({
    conversationId,
    onTranscript: (text, meta) => {
      // A transcript is submitted exactly like typed text — same endpoint,
      // same conversation, same agent.
      void send(text, { inputMode: 'voice', language: meta.language });
    },
  });
  voiceRef.current = voice;

  // Keep the "thinking" state honest while the agent works.
  useEffect(() => {
    if (voice.state === 'thinking' && !pending) voice.setThinking(false);
  }, [pending, voice]);

  /** Update one turn in place, so the payment states land on their own card. */
  const patchTurn = useCallback((turnId: string, patch: Partial<ChatTurn>) => {
    setTurns((current) =>
      current.map((turn) => (turn.id === turnId ? { ...turn, ...patch } : turn)),
    );
  }, []);

  /**
   * Approve and pay.
   *
   * The browser asks the server to create the provider order — it never names
   * an amount — then opens the provider's own checkout. The outcome the
   * provider reports is sent straight back for server-side verification; this
   * function never decides that a payment succeeded.
   */
  const pay = useCallback(
    async (turnId: string, confirmationId: string) => {
      patchTurn(turnId, { paymentPhase: 'preparing', paymentMessage: null });

      // The button click IS the customer's explicit approval of this exact
      // total, so it is recorded as such before anything is created. The
      // server still re-validates everything afterwards — granting a
      // confirmation is consent, not authorization.
      const granted = await fetch('/api/checkout/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'grant', confirmationId }),
      });

      if (!granted.ok) {
        const body = await granted.json().catch(() => null);
        patchTurn(turnId, {
          paymentPhase: 'failed',
          paymentMessage:
            body?.error?.message ??
            'That confirmation is no longer valid. Tell me when you are ready and I will re-quote.',
        });
        return;
      }

      const response = await fetch('/api/payments/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId }),
      });
      const created = await response.json().catch(() => null);

      if (response.status !== 200 || !created?.payment) {
        const details = created?.error?.details;

        // A moved total is not a failure — it needs a fresh yes.
        if (details?.old_total_display && details?.new_total_display) {
          patchTurn(turnId, {
            paymentPhase: 'idle',
            purchase: null,
            totalChanged: {
              oldDisplay: details.old_total_display,
              newDisplay: details.new_total_display,
              reason: created?.error?.message ?? 'Your cart changed.',
            },
          });
          return;
        }

        patchTurn(turnId, {
          paymentPhase: 'failed',
          paymentMessage:
            created?.error?.message ?? 'I could not prepare the payment. Nothing has been charged.',
        });
        return;
      }

      patchTurn(turnId, { paymentPhase: 'processing' });

      const outcome = await launchPayment({
        provider: created.payment.provider,
        publicKey: created.payment.key,
        providerOrderId: created.payment.provider_order_id,
        amountMinor: created.payment.amount,
        currency: created.payment.currency,
        customerName: created.payment.customer?.name ?? null,
        customerEmail: created.payment.customer?.email ?? null,
        conversationId,
      });

      if (outcome.status === 'succeeded') {
        patchTurn(turnId, {
          paymentPhase: 'succeeded',
          purchase: null,
          order: {
            id: outcome.orderId,
            orderNumber: outcome.orderNumber,
            totalDisplay: outcome.totalDisplay ?? created.payment.amount_display,
          },
        });
        // The cart is empty now, so the header badge has to catch up.
        await refreshCart();
        setTurns((current) => [
          ...current,
          { id: `a-${Date.now()}`, role: 'assistant', content: outcome.message },
        ]);
        return;
      }

      patchTurn(turnId, {
        paymentPhase:
          outcome.status === 'verification_pending'
            ? 'verification_pending'
            : outcome.status === 'cancelled'
              ? 'cancelled'
              : 'failed',
        paymentMessage: outcome.message,
      });
    },
    [conversationId, patchTurn, refreshCart],
  );

  return (
    <>
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-5">
        {turns.length === 0 && !pending ? (
          <EmptyConversation aiEnabled={aiEnabled} onPick={(text) => void send(text)} />
        ) : null}

        <div className="flex flex-col gap-4">
          {turns.map((turn) =>
            turn.role === 'user' ? (
              <UserBubble key={turn.id} text={turn.content} />
            ) : (
              <AssistantTurn
                key={turn.id}
                turn={turn}
                onCompare={compare}
                onAddToCart={(id, name) => void addToCart(id, name)}
                onReply={(text) => void send(text)}
                onPay={(confirmationId) => void pay(turn.id, confirmationId)}
              />
            ),
          )}
        </div>

        {pending ? <ThinkingBubble /> : null}

        {error ? (
          <div className="mt-4 flex items-start gap-2.5 rounded-[12px] border border-[rgba(255,107,107,.3)] bg-[rgba(255,107,107,.06)] px-4 py-3 text-[13.5px] leading-relaxed text-[#FF8B8B]">
            <AlertIcon size={15} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send(input);
        }}
        className="flex flex-col gap-2.5 border-t border-white/7 px-5 py-4"
      >
        {/* Voice sits above the composer, never replacing it — the text box
            stays available at every moment, including while listening. */}
        <VoiceControl
          state={voice.state}
          level={voice.level}
          error={voice.error}
          supported={voice.supported}
          unsupportedReason={voice.unsupportedReason}
          onToggle={voice.toggle}
          onRetry={() => {
            voice.clearError();
            voice.toggle();
          }}
          onTypeInstead={() => {
            voice.clearError();
            inputRef.current?.focus();
          }}
          compact
        />

        <div className="flex items-center gap-2.5">
        <input
          ref={inputRef}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Ask ShopiQ anything…"
          maxLength={1000}
          aria-label="Message ShopiQ"
          disabled={pending}
          className="h-11 min-w-0 flex-1 rounded-full border border-white/9 bg-[#101014] px-4 text-[14px] text-white outline-none transition-colors placeholder:text-[#7E7E88] focus:border-[rgba(247,147,30,.5)] disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={pending || !input.trim()}
          aria-label="Send"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full brand-gradient text-[#1A0D02] transition-[filter,opacity] hover:brightness-107 disabled:opacity-40"
        >
          {pending ? (
            <SpinnerIcon size={17} />
          ) : (
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 12h15M13 6l6 6-6 6" />
            </svg>
          )}
        </button>
        </div>
      </form>
    </>
  );
}

/* ------------------------------------------------------------------ pieces */

function EmptyConversation({
  aiEnabled,
  onPick,
}: {
  aiEnabled: boolean | null;
  onPick: (text: string) => void;
}) {
  return (
    <div className="pb-2">
      <div className="flex gap-2.5">
        <span className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-lg brand-gradient text-[#1A0D02]">
          <SparkIcon size={12} />
        </span>
        <div className="rounded-[4px_15px_15px_15px] border border-white/7 bg-[#0F0F12] px-[15px] py-3">
          <p className="m-0 text-[14.5px] leading-[1.55] text-[#EDEDF0]">
            Tell me what you&apos;re looking for and roughly what you want to spend. I&apos;ll
            search the real ShopiQ catalogue and explain why each pick fits.
          </p>
        </div>
      </div>

      <div className="ml-9 mt-4 flex flex-col gap-2">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => onPick(suggestion)}
            className="rounded-[12px] border border-white/8 bg-[#0C0C0E] px-3.5 py-2.5 text-left text-[13.5px] leading-snug text-[#C6C6CC] transition-colors hover:border-[rgba(247,147,30,.4)] hover:text-white"
          >
            {suggestion}
          </button>
        ))}
      </div>

      {aiEnabled === false ? (
        <p className="ml-9 mt-4 mb-0 text-[12px] leading-relaxed text-[#6E6E76]">
          No language model is configured, so ShopiQ is answering in deterministic mode: the
          search, filtering, scoring and explanations all still run — the wording is just
          templated rather than generated.
        </p>
      ) : null}
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <p className="m-0 max-w-[85%] rounded-[15px_15px_4px_15px] bg-[#17171B] px-[15px] py-3 text-[14.5px] leading-[1.55] text-[#EDEDF0]">
        {text}
      </p>
    </div>
  );
}

function ThinkingBubble() {
  return (
    <div className="mt-4 flex gap-2.5" aria-live="polite">
      <span className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-lg brand-gradient text-[#1A0D02]">
        <SparkIcon size={12} />
      </span>
      <div className="flex items-center gap-2 rounded-[4px_15px_15px_15px] border border-white/7 bg-[#0F0F12] px-[15px] py-3.5">
        <span className="flex gap-1">
          {[0, 1, 2].map((index) => (
            <span
              key={index}
              className="h-1.5 w-1.5 rounded-full bg-[#F7931E]"
              style={{
                animation: 'pulse 1.2s ease-in-out infinite',
                animationDelay: `${index * 0.18}s`,
              }}
            />
          ))}
        </span>
        <span className="text-[13px] text-[#7E7E88]">Searching the catalogue…</span>
      </div>
    </div>
  );
}

function AssistantTurn({
  turn,
  onCompare,
  onAddToCart,
  onReply,
  onPay,
}: {
  turn: ChatTurn;
  onCompare: (productIds: string[]) => void;
  onAddToCart: (productId: string, name: string) => void;
  onReply: (text: string) => void;
  onPay: (confirmationId: string) => void;
}) {
  const products = turn.products ?? [];
  const compareAction = turn.actions?.find(
    (action): action is Extract<AgentAction, { type: 'compare' }> => action.type === 'compare',
  );

  return (
    <div>
      <div className="flex gap-2.5">
        <span className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-lg brand-gradient text-[#1A0D02]">
          <SparkIcon size={12} />
        </span>
        <div className="min-w-0 rounded-[4px_15px_15px_15px] border border-white/7 bg-[#0F0F12] px-[15px] py-3">
          <p className="m-0 whitespace-pre-wrap text-[14.5px] leading-[1.55] text-[#EDEDF0]">
            {turn.content}
          </p>
        </div>
      </div>

      {turn.outcome === 'empty' ? (
        <div className="ml-9 mt-3 flex items-start gap-2.5 rounded-[12px] border border-[rgba(247,147,30,.3)] bg-[rgba(247,147,30,.06)] px-3.5 py-3 text-[13px] leading-relaxed text-[#FFC07A]">
          <AlertIcon size={14} className="mt-0.5 shrink-0" />
          <span>Nothing in the catalogue met every requirement.</span>
        </div>
      ) : null}

      {products.length > 0 ? (
        <div className="ml-9 mt-3 flex flex-col gap-2.5">
          {products.map((product, index) => (
            <AiProductCard
              key={product.productId}
              product={product}
              position={index + 1}
              onAddToCart={onAddToCart}
            />
          ))}
        </div>
      ) : null}

      {turn.comparison ? <ComparisonTable comparison={turn.comparison} /> : null}

      {turn.pendingAction ? (
        <AiConfirmCard
          summary={turn.pendingAction.summary + '?'}
          onConfirm={() => onReply('Yes, go ahead')}
          onCancel={() => onReply('No, keep it')}
        />
      ) : null}

      {turn.cart && !turn.pendingAction ? <AiCartCard cart={turn.cart} /> : null}
      {turn.checkout ? <AiCheckoutCard checkout={turn.checkout} /> : null}

      {/* Phase 4 — the exact total, the payment states, and the outcome. */}
      {turn.purchase ? (
        <AiPurchaseCard
          purchase={turn.purchase}
          phase={turn.paymentPhase ?? 'idle'}
          onApprove={() => onPay(turn.purchase!.confirmationId)}
          onDecline={() => onReply('No, not right now')}
        />
      ) : null}

      {turn.paymentPhase && turn.paymentPhase !== 'idle' && turn.paymentPhase !== 'succeeded' ? (
        <AiPaymentStatus phase={turn.paymentPhase} />
      ) : null}

      {turn.order ? (
        <AiOrderConfirmedCard
          orderId={turn.order.id}
          orderNumber={turn.order.orderNumber}
          totalDisplay={turn.order.totalDisplay}
        />
      ) : null}

      {turn.totalChanged ? (
        <AiTotalChangedCard
          oldTotalDisplay={turn.totalChanged.oldDisplay}
          newTotalDisplay={turn.totalChanged.newDisplay}
          reason={turn.totalChanged.reason}
          onReview={() => onReply('I am ready to buy')}
        />
      ) : null}

      {(turn.paymentPhase === 'failed' || turn.paymentPhase === 'verification_pending') &&
      turn.paymentMessage ? (
        <AiPaymentFailedCard
          message={turn.paymentMessage}
          verificationPending={turn.paymentPhase === 'verification_pending'}
          onRetry={() => onReply('I am ready to buy')}
        />
      ) : null}

      {compareAction && products.length >= 2 && !turn.comparison ? (
        <div className="ml-9 mt-3">
          <button
            type="button"
            onClick={() => onCompare(compareAction.productIds)}
            className="rounded-full border border-white/12 px-3.5 py-2 text-[12.5px] text-[#C6C6CC] transition-colors hover:border-[rgba(247,147,30,.5)] hover:text-white"
          >
            Compare the top two
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Compact recommendation card, sized for the 420px panel. */
function AiProductCard({
  product,
  position,
  onAddToCart,
}: {
  product: RecommendedProductPayload;
  position: number;
  onAddToCart: (productId: string, name: string) => void;
}) {
  return (
    <article className="overflow-hidden rounded-[13px] border border-white/8 bg-[#0C0C0E] transition-colors hover:border-[rgba(247,147,30,.4)]">
      <div className="flex gap-3 p-2.5">
        <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-[9px] bg-[#141418]">
          {product.image ? (
            <Image
              src={product.image}
              alt={product.name}
              fill
              sizes="48px"
              className="object-cover"
            />
          ) : null}
          <span className="absolute left-0 top-0 grid h-4 w-4 place-items-center rounded-br-[6px] bg-black/70 font-mono text-[9px] text-[#C6C6CC]">
            {position}
          </span>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="font-mono text-[9.5px] uppercase leading-none tracking-[0.1em] text-[#7E7E88]">
                {product.brand}
              </div>
              <div className="mt-1 truncate text-[13px] font-medium leading-[1.3] text-[#EDEDF0]">
                {product.name}
              </div>
            </div>
            {product.score > 0 ? (
              <span
                className="shrink-0 rounded-[6px] bg-[rgba(247,147,30,.14)] px-1.5 py-0.5 font-mono text-[10px] font-medium text-[#FFB65C]"
                title="ShopiQ match score, computed from your stated requirements"
              >
                {product.score}
              </span>
            ) : null}
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className="font-mono text-[12.5px] font-medium text-[#F7931E]">
              {formatPrice(product.price)}
            </span>
            {product.compareAtPrice && product.compareAtPrice > product.price ? (
              <span className="font-mono text-[11px] text-[#6E6E76] line-through">
                {formatPrice(product.compareAtPrice)}
              </span>
            ) : null}
            {product.rating > 0 ? (
              <span className="flex items-center gap-1 text-[11px] text-[#9A9AA2]">
                <StarIcon size={10} className="text-[#F7931E]" />
                {product.rating.toFixed(1)}
              </span>
            ) : null}
            <span
              className={cx(
                'text-[11px]',
                !product.available
                  ? 'text-[#FF8B8B]'
                  : product.lowStock
                    ? 'text-[#FFB65C]'
                    : 'text-[#4ED17E]',
              )}
            >
              {!product.available
                ? 'Out of stock'
                : product.lowStock
                  ? `Only ${product.availableQuantity} left`
                  : 'In stock'}
            </span>
          </div>
        </div>
      </div>

      {product.matchReasons.length > 0 ? (
        <ul className="m-0 list-none border-t border-white/6 px-2.5 py-2 pl-3">
          {product.matchReasons.slice(0, 3).map((reason) => (
            <li
              key={reason}
              className="flex items-start gap-1.5 text-[11.5px] leading-snug text-[#9A9AA2]"
            >
              <span className="mt-[5px] h-1 w-1 shrink-0 rounded-full bg-[#4ED17E]" />
              {reason}
            </li>
          ))}
        </ul>
      ) : null}

      {product.limitations.length > 0 ? (
        <ul className="m-0 list-none border-t border-white/6 px-2.5 py-2 pl-3">
          {product.limitations.slice(0, 2).map((limitation) => (
            <li
              key={limitation}
              className="flex items-start gap-1.5 text-[11.5px] leading-snug text-[#FFB65C]"
            >
              <span className="mt-[5px] h-1 w-1 shrink-0 rounded-full bg-[#FFB65C]" />
              {limitation}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex gap-2 border-t border-white/6 px-2.5 py-2">
        <button
          type="button"
          onClick={() => onAddToCart(product.productId, product.name)}
          disabled={!product.available}
          className="inline-flex h-7 items-center rounded-[8px] brand-gradient px-3 text-[11.5px] font-semibold text-[#1A0D02] transition-[filter,opacity] hover:brightness-107 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {product.available ? 'Add to Cart' : 'Out of stock'}
        </button>
        {product.slug ? (
          <Link
            href={`/products/${product.slug}`}
            className="inline-flex h-7 items-center rounded-[8px] border border-white/12 px-3 text-[11.5px] font-medium text-[#E6E6EA] transition-colors hover:border-white/28 hover:text-white"
          >
            View product
          </Link>
        ) : null}
      </div>
    </article>
  );
}

function ComparisonTable({ comparison }: { comparison: ComparisonPayload }) {
  const [expanded, setExpanded] = useState(false);
  const rows = expanded ? comparison.rows : comparison.rows.slice(0, 7);

  return (
    <div className="ml-9 mt-3 overflow-hidden rounded-[13px] border border-white/8 bg-[#0A0A0C]">
      <div className="grid grid-cols-[minmax(72px,1fr)_1fr_1fr] gap-px bg-white/6">
        <div className="bg-[#0C0C0E] px-2.5 py-2" />
        {comparison.products.slice(0, 2).map((product) => (
          <div key={product.productId} className="bg-[#0C0C0E] px-2.5 py-2 text-center">
            <div className="truncate text-[11.5px] font-medium text-[#EDEDF0]">{product.name}</div>
            <div className="mt-1 font-mono text-[10.5px] text-[#F7931E]">
              {formatPrice(product.price)}
            </div>
          </div>
        ))}

        {rows.map((row) => (
          <RowCells key={row.key} row={row} />
        ))}
      </div>

      {comparison.rows.length > 7 ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="w-full border-t border-white/6 py-2 text-[11.5px] text-[#9A9AA2] transition-colors hover:text-white"
        >
          {expanded ? 'Show less' : `Show all ${comparison.rows.length} attributes`}
        </button>
      ) : null}

      <p className="m-0 border-t border-white/6 px-3 py-2 text-[11px] leading-relaxed text-[#6E6E76]">
        {comparison.summary}
      </p>
    </div>
  );
}

function RowCells({ row }: { row: ComparisonPayload['rows'][number] }) {
  return (
    <>
      <div className="bg-[#0A0A0C] px-2.5 py-2 text-[11px] leading-snug text-[#7E7E88]">
        {row.label}
      </div>
      {row.values.slice(0, 2).map((value, index) => (
        <div
          key={index}
          className={cx(
            'bg-[#0A0A0C] px-2.5 py-2 text-center text-[11.5px] leading-snug',
            row.winner === index ? 'font-medium text-[#FFB65C]' : 'text-[#EDEDF0]',
          )}
        >
          {value === null ? <span className="text-[#4E4E56]">—</span> : String(value)}
        </div>
      ))}
    </>
  );
}
