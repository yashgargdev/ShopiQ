import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { ApiError, badRequest, jsonOk, withErrorHandling } from '@/lib/api/response';
import { runAgent } from '@/lib/ai/agent';
import { responseTypeFor, shouldSpeak, speakableSummary } from '@/lib/ai/response-type';
import { recordAiUsage, recordCommerceEvent, recordRecommendations } from '@/lib/analytics/track';
import {
  appendMessage,
  ensureTitle,
  loadHistory,
  openConversation,
  saveState,
  AI_SESSION_COOKIE,
} from '@/lib/ai/conversation/store';
import { providerStatus } from '@/lib/ai/provider';
import {
  AI_CHAT_LIMITS,
  MAX_MESSAGE_LENGTH,
  MAX_REQUEST_BYTES,
  checkRateLimit,
} from '@/lib/ai/rate-limit';
import { getSessionUser } from '@/lib/auth';
import type { AssistantMetadata } from '@/lib/ai/types';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/ai/chat
 *
 * The one public entry point to the AI. It owns the guardrails:
 *   - request size and message length caps
 *   - per-session and per-IP rate limits
 *   - conversation ownership (a guessed id returns 404)
 *   - graceful degradation when the AI provider is down
 *
 * The response contract is provider-agnostic by design — the client is never
 * told which model produced the answer beyond a coarse `provider` label.
 */

const chatRequestSchema = z
  .object({
    conversationId: z.string().uuid().nullish(),
    message: z
      .string()
      .trim()
      .min(1, 'Type something to send.')
      .max(MAX_MESSAGE_LENGTH, `Keep messages under ${MAX_MESSAGE_LENGTH} characters.`),
    /**
     * How the customer produced this message. Recorded as metadata only — the
     * agent behaves identically either way and nothing downstream branches on
     * it. Voice must never become a different code path, least of all around
     * the payment confirmation.
     */
    inputMode: z.enum(['text', 'voice']).nullish(),
    /** Language the speech layer detected. Metadata, used for TTS continuity. */
    language: z.string().max(12).nullish(),
  })
  .strict();

export const POST = withErrorHandling(async (request: NextRequest) => {
  // ---- size guard, before parsing --------------------------------------
  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new ApiError('PAYLOAD_TOO_LARGE', 'That message is too large.');
  }

  const raw = await request.text();
  if (raw.length > MAX_REQUEST_BYTES) {
    throw new ApiError('PAYLOAD_TOO_LARGE', 'That message is too large.');
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw badRequest('Expected a JSON body.');
  }

  const { conversationId, message, inputMode, language } = chatRequestSchema.parse(body);

  // ---- rate limits ------------------------------------------------------
  const user = await getSessionUser();
  const sessionCookie = request.cookies.get(AI_SESSION_COOKIE)?.value;
  const identity = user?.id ?? sessionCookie ?? 'anonymous';
  const ip = clientIp(request);

  const sessionVerdict = checkRateLimit(`ai:session:${identity}`, AI_CHAT_LIMITS.perSession);
  const ipVerdict = checkRateLimit(`ai:ip:${ip}`, AI_CHAT_LIMITS.perIp);

  if (!sessionVerdict.allowed || !ipVerdict.allowed) {
    const retryAfter = Math.max(sessionVerdict.retryAfter, ipVerdict.retryAfter);
    return jsonOk(
      {
        error: {
          code: 'RATE_LIMITED',
          message: `You're sending messages faster than ShopiQ can answer. Try again in ${retryAfter} ${retryAfter === 1 ? 'second' : 'seconds'}.`,
        },
      },
      { status: 429, headers: { 'Retry-After': String(retryAfter), 'Cache-Control': 'no-store' } },
    );
  }

  // ---- conversation -----------------------------------------------------
  const conversation = await openConversation(conversationId ?? null);
  const history = await loadHistory(conversation.id);

  // The turn is stored identically however it arrived; input_mode is a label
  // on the same row, not a fork in the conversation.
  await appendMessage(conversation.id, 'user', message, {
    input_mode: inputMode ?? 'text',
    ...(language ? { language } : {}),
  });
  await ensureTitle(conversation.id, message);

  // ---- agent ------------------------------------------------------------
  const agentStartedAt = Date.now();
  let reply;
  try {
    reply = await runAgent(message, {
      conversationId: conversation.id,
      history,
      state: conversation.state,
      lastShownProductIds: conversation.lastShownProductIds,
      lastShownProducts: conversation.lastShownProducts,
    });
  } catch (error) {
    console.error('[shopiq] agent failure:', error);

    // The storefront must survive an AI outage (Phase 2 §34). Persist a
    // recoverable turn rather than throwing a 500 at the panel.
    const fallback =
      'ShopiQ AI is temporarily unavailable, so I could not work through that just now. You can keep browsing and searching the catalogue as normal — everything else is working.';

    await appendMessage(conversation.id, 'assistant', fallback, {
      outcome: 'error',
      degraded: true,
      provider: providerStatus().provider,
    } satisfies AssistantMetadata);

    return jsonOk(
      {
        conversationId: conversation.id,
        message: fallback,
        products: [],
        comparison: null,
        actions: [],
        outcome: 'error',
        degraded: true,
        cart: null,
        checkout: null,
        pendingAction: null,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const agentLatencyMs = Date.now() - agentStartedAt;

  // Latency is measured directly and is always real. Token counts are only
  // recorded when the provider actually reports them — an estimated cost built
  // on a guessed token count would look identical to a measured one on the
  // dashboard, which is worse than showing nothing.
  await recordAiUsage({
    conversationId: conversation.id,
    kind: 'chat',
    provider: reply.degraded ? 'deterministic' : (reply.provider ?? 'unknown'),
    latencyMs: agentLatencyMs,
  });

  const metadata: AssistantMetadata = {
    products: reply.products,
    comparison: reply.comparison,
    actions: reply.actions,
    requirements: reply.requirements,
    intent: reply.intent,
    outcome: reply.outcome,
    toolsUsed: reply.toolsUsed,
    provider: reply.provider,
    degraded: reply.degraded,
    cart: reply.cart,
    checkout: reply.checkout,
    pendingAction: reply.pendingAction,
    purchase: reply.purchase ?? null,
    // Only the internal payment id is persisted on the transcript. The
    // publishable key, the provider order id and any signature are not
    // conversation history.
    paymentId: reply.payment?.paymentId ?? null,
    order: reply.order ?? null,
  };

  await appendMessage(conversation.id, 'assistant', reply.message, metadata);
  await saveState(conversation.id, reply.requirements);

  // ---- attribution -------------------------------------------------------
  //
  // Recorded at the moment the customer is SHOWN something, which is the only
  // point at which the causal claim is honest. Reconstructing "the AI probably
  // sold this" from order history afterwards would produce a much prettier
  // number and mean nothing.
  const tracking = {
    conversationId: conversation.id,
    customerId: user?.id ?? null,
    sessionKey: sessionCookie ?? null,
  };
  const channel = inputMode === 'voice' ? ('voice' as const) : ('ai' as const);

  if (reply.products.length > 0) {
    // Cross-sell is tracked separately because it is the metric the merchant
    // dashboard reports on its own.
    const source = reply.intent === 'cross_sell' ? 'ai_cross_sell' : 'ai_search';
    await recordRecommendations(
      tracking,
      reply.products.map((product) => ({ productId: product.productId, score: product.score })),
      source,
    );
    await recordCommerceEvent(
      source === 'ai_cross_sell' ? 'ai_cross_sell_shown' : 'ai_recommendation_shown',
      tracking,
      { channel, detail: { count: reply.products.length, outcome: reply.outcome } },
    );
  }

  if (reply.checkout || reply.purchase) {
    await recordCommerceEvent('ai_checkout_started', tracking, {
      channel,
      valueMinor: reply.purchase?.amountMinor ?? null,
    });
  }

  return jsonOk(
    {
      conversationId: conversation.id,
      message: reply.message,
      products: reply.products,
      comparison: reply.comparison,
      actions: reply.actions,
      intent: reply.intent,
      outcome: reply.outcome,
      degraded: reply.degraded,
      /**
       * Which payload this turn carries, so a renderer picks a component
       * instead of re-deriving it from four nullable fields. Server-derived,
       * so the model cannot be wrong about it.
       */
      type: responseTypeFor(reply),
      /** The short line to SPEAK. The screen keeps the full message. */
      speech: shouldSpeak(reply) ? speakableSummary(reply) : null,
      cart: reply.cart,
      checkout: reply.checkout,
      pendingAction: reply.pendingAction,
      /** An exact total awaiting the customer's explicit approval. */
      purchase: reply.purchase ?? null,
      /**
       * What the browser needs to open Razorpay Checkout. `publicKey` is the
       * publishable key id; the API secret and webhook secret never appear in
       * any response.
       */
      payment: reply.payment ?? null,
      order: reply.order ?? null,
      /** Coarse label only — never the model id or provider internals. */
      provider: reply.degraded ? 'deterministic' : 'ai',
      /**
       * Safe structured decision metadata.
       *
       * This is deliberately NOT chain-of-thought. It is the set of facts the
       * backend derived and acted on — what it understood, which tools it was
       * allowed to run, and which products it considered — so a reviewer can
       * audit a decision without the system ever narrating hidden reasoning.
       * Nothing here comes from the model's own account of itself.
       */
      decision: {
        intent: reply.intent,
        requirements: reply.requirements,
        tools_used: reply.toolsUsed ?? [],
        products_considered: reply.products.length,
        /**
         * The top pick's reasons, drawn from catalogue values by the scoring
         * engine — not a sentence the model wrote about itself.
         */
        recommendation_reason: reply.products[0]?.matchReasons?.[0] ?? null,
        outcome: reply.outcome,
        degraded: reply.degraded,
      },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
});

/**
 * GET /api/ai/chat?conversationId=… — replay a conversation.
 * Ownership is checked by openConversation; a foreign id 404s.
 */
export const GET = withErrorHandling(async (request: NextRequest) => {
  const id = request.nextUrl.searchParams.get('conversationId');
  if (!id) {
    return jsonOk(
      { conversationId: null, messages: [], status: providerStatus().available },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) throw badRequest('Invalid conversation id.');

  const conversation = await openConversation(parsed.data);
  const history = await loadHistory(conversation.id, 40);

  return jsonOk(
    {
      conversationId: conversation.id,
      messages: history.map((entry) => ({
        id: entry.id,
        role: entry.role,
        content: entry.content,
        metadata: entry.metadata,
        createdAt: entry.createdAt,
      })),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
});

function clientIp(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return request.headers.get('x-real-ip') ?? 'unknown';
}
