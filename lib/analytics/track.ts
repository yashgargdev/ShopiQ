import 'server-only';
import { adminClient } from '@/lib/supabase/admin';

/**
 * Commerce analytics and AI revenue attribution.
 *
 * The rule that matters: **attribution is recorded when it happens, never
 * reconstructed afterwards.** A row is written the moment the AI shows a
 * product, and updated in place as the customer clicks, adds and buys. Nothing
 * here infers that the AI "probably" caused a sale — if there is no impression
 * row, the AI gets no credit.
 *
 * Every function is best-effort and never throws. Analytics failing must not
 * break a customer's shopping trip, but it must be visible in the logs.
 */

export type RecommendationSource =
  | 'ai_search'
  | 'ai_recommendation'
  | 'ai_cross_sell'
  | 'ai_comparison'
  | 'related_products';

export type CommerceChannel = 'ai' | 'web' | 'voice';

/** The funnel events the merchant dashboard counts. */
export type CommerceEvent =
  | 'product_viewed'
  | 'ai_conversation_started'
  | 'ai_recommendation_shown'
  | 'ai_recommendation_clicked'
  | 'ai_add_to_cart'
  | 'web_add_to_cart'
  | 'ai_cross_sell_shown'
  | 'ai_checkout_started'
  | 'checkout_started'
  | 'order_paid';

export interface TrackingIdentity {
  conversationId?: string | null;
  customerId?: string | null;
  /** Stable per-visitor key so guest journeys are attributable too. */
  sessionKey?: string | null;
}

function log(scope: string, error: unknown) {
  console.error(`[analytics] ${scope}`, error);
}

/**
 * Record that the AI showed a set of products.
 *
 * One row per product, with its position and score, so the dashboard can later
 * answer "did rank matter" and "which source converts" without guessing.
 */
export async function recordRecommendations(
  identity: TrackingIdentity,
  products: Array<{ productId: string; score?: number }>,
  source: RecommendationSource,
  variant = 'control',
): Promise<void> {
  if (products.length === 0) return;
  try {
    await adminClient()
      .from('ai_recommendations')
      .insert(
        products.map((product, index) => ({
          conversation_id: identity.conversationId ?? null,
          customer_id: identity.customerId ?? null,
          session_key: identity.sessionKey ?? null,
          product_id: product.productId,
          source,
          position: index + 1,
          score: typeof product.score === 'number' ? product.score : null,
          variant,
        })),
      );
  } catch (error) {
    log('recordRecommendations', error);
  }
}

/**
 * Mark the most recent live impression of a product as clicked or added.
 *
 * Scoped to this customer/session and to impressions that have not already
 * converted, so a fresh add updates the impression that actually preceded it
 * rather than an ancient one.
 */
export async function markRecommendation(
  identity: TrackingIdentity,
  productId: string,
  stage: 'clicked' | 'added_to_cart',
): Promise<void> {
  const column = stage === 'clicked' ? 'clicked_at' : 'added_to_cart_at';
  try {
    const db = adminClient();
    let query = db
      .from('ai_recommendations')
      .select('id')
      .eq('product_id', productId)
      .is('purchased_at', null)
      .order('shown_at', { ascending: false })
      .limit(1);

    // Prefer the customer, fall back to the session — a guest who signs in
    // mid-journey should not lose their attribution chain.
    if (identity.customerId) query = query.eq('customer_id', identity.customerId);
    else if (identity.sessionKey) query = query.eq('session_key', identity.sessionKey);
    else if (identity.conversationId) query = query.eq('conversation_id', identity.conversationId);
    else return;

    const { data } = await query.maybeSingle();
    if (!data) return;

    await db
      .from('ai_recommendations')
      .update({ [column]: new Date().toISOString() })
      .eq('id', data.id)
      .is(column, null);
  } catch (error) {
    log('markRecommendation', error);
  }
}

/** Record one funnel step. */
export async function recordCommerceEvent(
  event: CommerceEvent,
  identity: TrackingIdentity,
  options: {
    channel?: CommerceChannel;
    productId?: string | null;
    orderId?: string | null;
    valueMinor?: number | null;
    detail?: Record<string, unknown>;
  } = {},
): Promise<void> {
  try {
    await adminClient()
      .from('commerce_events')
      .insert({
        event,
        conversation_id: identity.conversationId ?? null,
        customer_id: identity.customerId ?? null,
        session_key: identity.sessionKey ?? null,
        product_id: options.productId ?? null,
        order_id: options.orderId ?? null,
        channel: options.channel ?? 'web',
        value_minor: options.valueMinor ?? null,
        detail: options.detail ?? {},
      });
  } catch (error) {
    log('recordCommerceEvent', error);
  }
}

/**
 * Attribute a paid order's revenue back to the recommendations that produced
 * it. Runs once per order, inside the database, so the precedence rules and
 * the "attribute exactly once" guarantee live next to the data.
 */
export async function attributeOrder(orderId: string): Promise<number> {
  try {
    const { data, error } = await adminClient().rpc('attribute_order_revenue', {
      p_order_id: orderId,
    });
    if (error) {
      log('attributeOrder', error);
      return 0;
    }
    return Number(data ?? 0);
  } catch (error) {
    log('attributeOrder', error);
    return 0;
  }
}

/**
 * Record AI usage for cost and latency reporting.
 *
 * `costMinor` is only ever written when the provider reported real usage. An
 * estimate built on a guessed token count would look identical to a measured
 * one in the dashboard, which is worse than showing nothing.
 */
export async function recordAiUsage(input: {
  conversationId?: string | null;
  kind: 'chat' | 'extraction' | 'stt' | 'tts';
  provider: string;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  audioSeconds?: number | null;
  latencyMs?: number | null;
  costMinor?: number | null;
}): Promise<void> {
  try {
    await adminClient()
      .from('ai_usage')
      .insert({
        conversation_id: input.conversationId ?? null,
        kind: input.kind,
        provider: input.provider,
        model: input.model ?? null,
        input_tokens: input.inputTokens ?? null,
        output_tokens: input.outputTokens ?? null,
        audio_seconds: input.audioSeconds ?? null,
        latency_ms: input.latencyMs ?? null,
        cost_minor: input.costMinor ?? null,
      });
  } catch (error) {
    log('recordAiUsage', error);
  }
}
