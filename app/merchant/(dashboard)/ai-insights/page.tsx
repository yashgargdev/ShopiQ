import type { Metadata } from 'next';
import Link from 'next/link';

import { requireMerchant } from '@/lib/auth';
import { formatPrice } from '@/lib/format';
import {
  getAiCommerceStats,
  getAiCostSummary,
  getAiOpportunities,
  type RateFigure,
} from '@/lib/analytics/queries';
import { StatCard } from '@/components/merchant/StatCard';

export const metadata: Metadata = { title: 'AI Insights · ShopiQ Merchant' };
export const dynamic = 'force-dynamic';

/**
 * Merchant AI Insights.
 *
 * The whole point of this page is to answer one question honestly: is the AI
 * making money? So every figure is measured, and every rate with an empty
 * denominator renders **N/A** rather than 0% — a conversion rate over zero
 * sessions says nothing about the product, and showing it as 0% invites
 * exactly the wrong conclusion.
 */

/** Render a rate, or N/A when there is nothing to divide by. */
function Rate({ figure, suffix = '%' }: { figure: RateFigure; suffix?: string }) {
  if (figure.value === null) return <>N/A</>;
  return (
    <>
      {figure.value}
      {suffix}
    </>
  );
}

function rateHint(figure: RateFigure, unit: string): string {
  if (figure.value === null) return `No ${unit} yet`;
  return `${figure.numerator} of ${figure.denominator} ${unit}`;
}

export default async function AiInsightsPage() {
  await requireMerchant();

  const [stats, opportunities, cost] = await Promise.all([
    getAiCommerceStats(30),
    getAiOpportunities(5),
    getAiCostSummary(30),
  ]);

  return (
    <div className="space-y-8">
      <header className="space-y-1.5">
        <h1 className="text-[26px] font-semibold tracking-tight text-white">AI Commerce</h1>
        <p className="text-[13.5px] text-[#8A8A93]">
          What the assistant did over the last {stats.windowDays} days, and what it earned.
          Figures are measured from real orders — a rate with no data shows as N/A.
        </p>
      </header>

      {stats.empty ? (
        <div className="rounded-[16px] border border-white/8 bg-[#0C0C0F] p-8 text-center">
          <p className="text-[15px] font-medium text-white">No AI commerce data yet</p>
          <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-[#8A8A93]">
            Once customers start shopping through the assistant, their recommendations, cart
            additions and orders will be attributed here. Nothing on this page is simulated, so it
            stays empty until there is something real to show.
          </p>
          <Link
            href="/"
            className="mt-5 inline-flex h-9 items-center rounded-full brand-gradient px-4 text-[13px] font-semibold text-[#1A0D02]"
          >
            Open the storefront
          </Link>
        </div>
      ) : null}

      {/* ------------------------------------------------------- headline */}
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="AI conversations"
          value={String(stats.conversations)}
          hint={`${stats.aiSessions} took a commerce action`}
        />
        <StatCard
          label="AI-assisted orders"
          value={String(stats.aiOrders)}
          hint={`of ${stats.totalOrders} paid orders`}
          tone={stats.aiOrders > 0 ? 'ok' : 'default'}
        />
        <StatCard
          label="AI conversion"
          value={stats.aiConversion.value === null ? 'N/A' : `${stats.aiConversion.value}%`}
          hint={rateHint(stats.aiConversion, 'AI sessions converted')}
        />
        <StatCard
          label="AI-assisted revenue"
          value={formatPrice(stats.aiRevenue)}
          hint={`of ${formatPrice(stats.totalRevenue)} total`}
          tone={stats.aiRevenue > 0 ? 'ok' : 'default'}
        />
      </section>

      {/* ------------------------------------------------------------ AOV */}
      <section className="grid gap-3 sm:grid-cols-3">
        <StatCard
          label="Average order value"
          value={stats.aov.all.value === null ? 'N/A' : formatPrice(stats.aov.all.value)}
          hint={rateHint(stats.aov.all, 'orders')}
        />
        <StatCard
          label="AI-assisted AOV"
          value={stats.aov.ai.value === null ? 'N/A' : formatPrice(stats.aov.ai.value)}
          hint={rateHint(stats.aov.ai, 'AI orders')}
        />
        <StatCard
          label="Non-AI AOV"
          value={stats.aov.nonAi.value === null ? 'N/A' : formatPrice(stats.aov.nonAi.value)}
          hint={rateHint(stats.aov.nonAi, 'other orders')}
        />
      </section>

      {/* ----------------------------------------------------- cross-sell */}
      <section className="rounded-[16px] border border-white/8 bg-[#0C0C0F] p-5">
        <div className="mb-4 flex items-baseline justify-between gap-3">
          <h2 className="text-[15px] font-semibold text-white">AI cross-sell</h2>
          <span className="text-[12px] text-[#7E7E88]">
            {formatPrice(stats.crossSell.revenue)} attributed
          </span>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: 'Shown', value: stats.crossSell.shown, rate: null },
            { label: 'Clicked', value: stats.crossSell.clicked, rate: stats.crossSell.clickRate },
            { label: 'Added', value: stats.crossSell.added, rate: stats.crossSell.addRate },
            {
              label: 'Purchased',
              value: stats.crossSell.purchased,
              rate: stats.crossSell.purchaseRate,
            },
          ].map((step) => (
            <div
              key={step.label}
              className="rounded-[12px] border border-white/7 bg-[#101014] px-4 py-3"
            >
              <div className="text-[11px] uppercase tracking-wide text-[#7E7E88]">{step.label}</div>
              <div className="mt-1 text-[20px] font-semibold text-white">{step.value}</div>
              {step.rate ? (
                <div className="mt-0.5 text-[11.5px] text-[#8A8A93]">
                  <Rate figure={step.rate} /> of shown
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </section>

      {/* -------------------------------------------------- opportunities */}
      <section className="space-y-3">
        <h2 className="text-[15px] font-semibold text-white">AI opportunity</h2>

        {opportunities.length === 0 ? (
          <p className="rounded-[14px] border border-white/8 bg-[#0C0C0F] px-5 py-6 text-[13px] text-[#8A8A93]">
            Nothing to report yet. Opportunities appear once the assistant has shown products and
            orders have been placed — they are derived from real co-purchases, never generated.
          </p>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {opportunities.map((opportunity) => (
              <article
                key={opportunity.productId}
                className="rounded-[16px] border border-white/8 bg-[#0C0C0F] p-5"
              >
                <div className="text-[11px] uppercase tracking-wide text-[#7E7E88]">
                  {opportunity.categoryName}
                </div>
                <h3 className="mt-1 text-[15px] font-semibold text-white">
                  {opportunity.productName}
                </h3>

                {opportunity.pairs.length > 0 ? (
                  <>
                    <p className="mt-3 text-[12.5px] text-[#8A8A93]">
                      Customers who bought this also bought:
                    </p>
                    <ol className="mt-2 space-y-1.5">
                      {opportunity.pairs.map((pair, index) => (
                        <li key={pair.productId} className="flex items-baseline gap-2 text-[13px]">
                          <span className="text-[#7E7E88]">{index + 1}.</span>
                          <span className="flex-1 text-[#EDEDF0]">{pair.name}</span>
                          <span className="text-[11.5px] text-[#7E7E88]">
                            {pair.timesPaired}×
                            {pair.attachRate !== null
                              ? ` · ${Math.round(pair.attachRate * 100)}%`
                              : ''}
                          </span>
                        </li>
                      ))}
                    </ol>
                  </>
                ) : (
                  <p className="mt-3 text-[12.5px] text-[#7E7E88]">
                    Not enough order history yet to name a reliable pairing.
                  </p>
                )}

                <div className="mt-4 flex items-center justify-between border-t border-white/7 pt-3">
                  <div>
                    <div className="text-[11px] uppercase tracking-wide text-[#7E7E88]">
                      Cross-sell revenue
                    </div>
                    <div className="text-[15px] font-semibold text-[#F7931E]">
                      {formatPrice(opportunity.crossSellRevenue)}
                    </div>
                  </div>
                  <div className="text-right text-[11.5px] text-[#8A8A93]">
                    {opportunity.impressions} impressions
                    <br />
                    {opportunity.conversions} converted
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {/* --------------------------------------------------- cost/latency */}
      <section className="rounded-[16px] border border-white/8 bg-[#0C0C0F] p-5">
        <h2 className="mb-4 text-[15px] font-semibold text-white">AI cost and latency</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="Chat calls" value={String(cost.chatCalls)} />
          <StatCard
            label="Avg chat latency"
            value={cost.avgChatLatencyMs === null ? 'N/A' : `${cost.avgChatLatencyMs} ms`}
          />
          <StatCard
            label="Avg STT latency"
            value={cost.avgSttLatencyMs === null ? 'N/A' : `${cost.avgSttLatencyMs} ms`}
            hint={`${cost.sttCalls} calls`}
          />
          <StatCard
            label="Avg TTS latency"
            value={cost.avgTtsLatencyMs === null ? 'N/A' : `${cost.avgTtsLatencyMs} ms`}
            hint={`${cost.ttsCalls} calls`}
          />
        </div>
        <p className="mt-4 text-[12px] leading-relaxed text-[#7E7E88]">
          {cost.estimatedCost === null ? (
            <>
              <span className="text-[#8A8A93]">Estimated cost: N/A.</span> The configured providers
              did not report token or duration usage for these calls, so there is no honest basis
              for a figure. Latency is measured directly and is real.
            </>
          ) : (
            <>
              <span className="text-[#8A8A93]">
                Estimated cost: {formatPrice(cost.estimatedCost)}.
              </span>{' '}
              Derived from provider-reported usage against a published rate card — an estimate, not
              an invoice.
              {cost.costIsPartial ? ' Some calls reported no usage and are excluded.' : ''}
            </>
          )}
        </p>
      </section>

      <p className="text-[12px] leading-relaxed text-[#6E6E76]">
        <strong className="text-[#8A8A93]">How attribution works.</strong> A row is written the
        moment the assistant shows a product, and updated as the customer clicks, adds and pays.
        Revenue is attributed once per order line, preferring a cross-sell over a search impression
        when both occurred — so cross-sell revenue and AI-assisted revenue never double-count the
        same rupee. Orders that were never paid are never attributed.
      </p>
    </div>
  );
}
