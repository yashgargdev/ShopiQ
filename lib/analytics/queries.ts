import 'server-only';
import { adminClient } from '@/lib/supabase/admin';

/**
 * Merchant-facing analytics.
 *
 * Every figure here is derived from rows that exist. Where a rate has an empty
 * denominator it is returned as `null` and the UI shows **N/A** — a 0%
 * conversion rate computed from zero sessions is not a fact about the product,
 * it is a fact about the absence of data, and presenting it as the former is
 * the single easiest way to make a dashboard lie.
 */

/**
 * A row or jsonb payload as PostgREST returns it. Values are genuinely dynamic
 * at this boundary, so the shape is named rather than pretended away.
 */
type JsonRecord = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface RateFigure {
  /** Null when the denominator is zero — the caller must render N/A. */
  value: number | null;
  numerator: number;
  denominator: number;
}

export interface CrossSellFunnel {
  shown: number;
  clicked: number;
  added: number;
  purchased: number;
  revenue: number;
  clickRate: RateFigure;
  addRate: RateFigure;
  purchaseRate: RateFigure;
}

export interface AiCommerceStats {
  windowDays: number;
  conversations: number;
  aiSessions: number;
  aiOrders: number;
  totalOrders: number;
  aiRevenue: number;
  nonAiRevenue: number;
  totalRevenue: number;
  aiConversion: RateFigure;
  aov: { all: RateFigure; ai: RateFigure; nonAi: RateFigure };
  crossSell: CrossSellFunnel;
  recommendations: { shown: number; added: number; addRate: RateFigure };
  /** True when there is genuinely nothing to report yet. */
  empty: boolean;
}

function rate(numerator: number, denominator: number, asPercent = true): RateFigure {
  if (!denominator || denominator <= 0) {
    return { value: null, numerator, denominator: denominator ?? 0 };
  }
  const raw = numerator / denominator;
  return {
    value: asPercent ? Math.round(raw * 1000) / 10 : Math.round(raw * 100) / 100,
    numerator,
    denominator,
  };
}

/**
 * The AI commerce figures for the merchant dashboard.
 *
 * The heavy lifting is one SQL function so the attribution rules live next to
 * the data rather than being re-implemented in TypeScript, where they would
 * drift.
 */
export async function getAiCommerceStats(days = 30): Promise<AiCommerceStats> {
  const { data, error } = await adminClient().rpc('ai_commerce_stats', { p_days: days });
  if (error) throw error;

  const raw = (data ?? {}) as JsonRecord;
  const cross = raw.crossSell ?? {};
  const recs = raw.recommendations ?? {};
  const aov = raw.aov ?? {};

  const crossSell: CrossSellFunnel = {
    shown: Number(cross.shown ?? 0),
    clicked: Number(cross.clicked ?? 0),
    added: Number(cross.added ?? 0),
    purchased: Number(cross.purchased ?? 0),
    revenue: Number(cross.revenue ?? 0),
    clickRate: rate(Number(cross.clicked ?? 0), Number(cross.shown ?? 0)),
    addRate: rate(Number(cross.added ?? 0), Number(cross.shown ?? 0)),
    purchaseRate: rate(Number(cross.purchased ?? 0), Number(cross.shown ?? 0)),
  };

  const conversations = Number(raw.conversations ?? 0);
  const totalOrders = Number(raw.totalOrders ?? 0);

  return {
    windowDays: Number(raw.windowDays ?? days),
    conversations,
    aiSessions: Number(raw.aiSessions ?? 0),
    aiOrders: Number(raw.aiOrders ?? 0),
    totalOrders,
    aiRevenue: Number(raw.aiRevenue ?? 0),
    nonAiRevenue: Number(raw.nonAiRevenue ?? 0),
    totalRevenue: Number(raw.totalRevenue ?? 0),
    aiConversion: rate(
      Number(raw.aiConversion?.numerator ?? 0),
      Number(raw.aiConversion?.denominator ?? 0),
    ),
    aov: {
      all: rate(Number(aov.allNumerator ?? 0), Number(aov.allDenominator ?? 0), false),
      ai: rate(Number(aov.aiNumerator ?? 0), Number(aov.aiDenominator ?? 0), false),
      nonAi: rate(Number(aov.nonAiNumerator ?? 0), Number(aov.nonAiDenominator ?? 0), false),
    },
    crossSell,
    recommendations: {
      shown: Number(recs.shown ?? 0),
      added: Number(recs.added ?? 0),
      addRate: rate(Number(recs.added ?? 0), Number(recs.shown ?? 0)),
    },
    empty: conversations === 0 && totalOrders === 0 && crossSell.shown === 0,
  };
}

export interface PairedProduct {
  productId: string;
  name: string;
  timesPaired: number;
  attachRate: number | null;
}

/**
 * What customers who bought this product also bought — from real orders only.
 *
 * Returns an empty list when there is not enough history. An insight engine
 * that always has an answer is one nobody should act on.
 */
export async function getFrequentlyBoughtTogether(
  productId: string,
  limit = 5,
): Promise<PairedProduct[]> {
  const { data, error } = await adminClient().rpc('frequently_bought_together', {
    p_product_id: productId,
    p_limit: limit,
  });
  if (error) throw error;

  return (data ?? []).map((row: JsonRecord) => ({
    productId: row.product_id,
    name: row.product_name,
    timesPaired: Number(row.times_paired),
    attachRate: row.attach_rate === null ? null : Number(row.attach_rate),
  }));
}

export interface AiOpportunity {
  productId: string;
  productName: string;
  categoryName: string;
  /** Real co-purchase pairs, may be empty. */
  pairs: PairedProduct[];
  /** Cross-sell revenue already attributed to this product, in rupees. */
  crossSellRevenue: number;
  impressions: number;
  conversions: number;
}

/**
 * The merchant "AI Opportunity" list.
 *
 * Ranked by how much cross-sell revenue each anchor product has already
 * produced, so the first row is the one where the evidence is strongest.
 * Products with no evidence are simply absent rather than padded in.
 */
export async function getAiOpportunities(limit = 5): Promise<AiOpportunity[]> {
  const db = adminClient();

  const { data: topAnchors, error } = await db
    .from('ai_recommendations')
    .select('product_id, revenue_minor, purchased_at, source')
    .eq('source', 'ai_cross_sell')
    .not('purchased_at', 'is', null)
    .limit(500);

  if (error) throw error;

  const revenueByProduct = new Map<string, { revenue: number; conversions: number }>();
  for (const row of topAnchors ?? []) {
    const current = revenueByProduct.get(row.product_id) ?? { revenue: 0, conversions: 0 };
    current.revenue += Number(row.revenue_minor ?? 0) / 100;
    current.conversions += 1;
    revenueByProduct.set(row.product_id, current);
  }

  // When nothing has converted yet, fall back to the most-shown products so
  // the merchant still sees where the AI is spending its impressions — clearly
  // reported as impressions, not as revenue.
  let candidateIds = [...revenueByProduct.entries()]
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .slice(0, limit)
    .map(([id]) => id);

  if (candidateIds.length === 0) {
    const { data: shown } = await db
      .from('ai_recommendations')
      .select('product_id')
      .limit(500);
    const counts = new Map<string, number>();
    for (const row of shown ?? []) {
      counts.set(row.product_id, (counts.get(row.product_id) ?? 0) + 1);
    }
    candidateIds = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id]) => id);
  }

  if (candidateIds.length === 0) return [];

  const { data: products } = await db
    .from('products')
    .select('id, name, categories(name)')
    .in('id', candidateIds);

  const { data: impressionRows } = await db
    .from('ai_recommendations')
    .select('product_id')
    .in('product_id', candidateIds);

  const impressions = new Map<string, number>();
  for (const row of impressionRows ?? []) {
    impressions.set(row.product_id, (impressions.get(row.product_id) ?? 0) + 1);
  }

  const opportunities: AiOpportunity[] = [];
  for (const id of candidateIds) {
    const product = (products ?? []).find((p) => p.id === id);
    if (!product) continue;
    const stats = revenueByProduct.get(id);
    opportunities.push({
      productId: id,
      productName: product.name,
      categoryName: (product.categories as { name?: string } | null)?.name ?? 'Uncategorised',
      pairs: await getFrequentlyBoughtTogether(id, 3),
      crossSellRevenue: stats?.revenue ?? 0,
      impressions: impressions.get(id) ?? 0,
      conversions: stats?.conversions ?? 0,
    });
  }

  return opportunities;
}

export interface AiCostSummary {
  windowDays: number;
  chatCalls: number;
  sttCalls: number;
  ttsCalls: number;
  avgChatLatencyMs: number | null;
  avgSttLatencyMs: number | null;
  avgTtsLatencyMs: number | null;
  /** Null when no provider reported priceable usage. Never estimated blind. */
  estimatedCost: number | null;
  costIsPartial: boolean;
}

/** AI cost and latency. Costs stay null unless the provider reported usage. */
export async function getAiCostSummary(days = 30): Promise<AiCostSummary> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await adminClient()
    .from('ai_usage')
    .select('kind, latency_ms, cost_minor')
    .gte('created_at', since);
  if (error) throw error;

  const rows = data ?? [];
  const avg = (kind: string) => {
    const values = rows.filter((r) => r.kind === kind && r.latency_ms != null).map((r) => r.latency_ms as number);
    return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null;
  };

  const priced = rows.filter((r) => r.cost_minor != null);
  const totalMinor = priced.reduce((sum, r) => sum + Number(r.cost_minor), 0);

  return {
    windowDays: days,
    chatCalls: rows.filter((r) => r.kind === 'chat' || r.kind === 'extraction').length,
    sttCalls: rows.filter((r) => r.kind === 'stt').length,
    ttsCalls: rows.filter((r) => r.kind === 'tts').length,
    avgChatLatencyMs: avg('chat'),
    avgSttLatencyMs: avg('stt'),
    avgTtsLatencyMs: avg('tts'),
    estimatedCost: priced.length ? totalMinor / 100 : null,
    costIsPartial: priced.length > 0 && priced.length < rows.length,
  };
}

export interface AuditEntry {
  at: string;
  kind: 'tool' | 'money' | 'voice';
  event: string;
  detail: string | null;
  status: string | null;
  durationMs: number | null;
  amount: number | null;
}

/**
 * A merged, human-readable audit trail for one conversation, customer or order.
 *
 * Reads the two existing audit surfaces — `ai_tool_logs` and `payment_events`
 * — and interleaves them by time. Deliberately server-side and merchant-only:
 * both tables are RLS-with-no-policy, so this is the only way anyone sees them.
 */
export async function getAuditTrail(filter: {
  conversationId?: string | null;
  customerId?: string | null;
  orderId?: string | null;
  limit?: number;
}): Promise<AuditEntry[]> {
  const db = adminClient();
  const limit = Math.min(filter.limit ?? 100, 300);
  const entries: AuditEntry[] = [];

  if (filter.conversationId) {
    const toolQuery = db
      .from('ai_tool_logs')
      .select('tool_name, status, error, execution_time_ms, created_at, input')
      .eq('conversation_id', filter.conversationId)
      .order('created_at', { ascending: true })
      .limit(limit);

    const { data: tools } = await toolQuery;
    for (const row of tools ?? []) {
      const isVoice = /^(stt|tts|voice)_/.test(row.tool_name);
      entries.push({
        at: row.created_at,
        kind: isVoice ? 'voice' : 'tool',
        event: row.tool_name,
        detail: row.error ?? null,
        status: row.status,
        durationMs: row.execution_time_ms,
        amount: null,
      });
    }
  }

  let moneyQuery = db
    .from('payment_events')
    .select('event, amount_minor, currency, detail, created_at')
    .order('created_at', { ascending: true })
    .limit(limit);

  if (filter.conversationId) moneyQuery = moneyQuery.eq('conversation_id', filter.conversationId);
  if (filter.customerId) moneyQuery = moneyQuery.eq('customer_id', filter.customerId);
  if (filter.orderId) moneyQuery = moneyQuery.eq('order_id', filter.orderId);

  // Without any filter this would dump the whole table, which is neither
  // useful nor appropriate.
  if (filter.conversationId || filter.customerId || filter.orderId) {
    const { data: money } = await moneyQuery;
    for (const row of money ?? []) {
      entries.push({
        at: row.created_at,
        kind: 'money',
        event: row.event,
        detail:
          typeof row.detail === 'object' && row.detail && Object.keys(row.detail).length
            ? JSON.stringify(row.detail).slice(0, 200)
            : null,
        status: null,
        durationMs: null,
        amount: row.amount_minor == null ? null : Number(row.amount_minor) / 100,
      });
    }
  }

  return entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(0, limit);
}
