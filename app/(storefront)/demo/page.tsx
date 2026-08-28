import type { Metadata } from 'next';
import Link from 'next/link';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { formatPrice } from '@/lib/format';
import { getAiCommerceStats } from '@/lib/analytics/queries';
import { paymentStatus } from '@/lib/payments';
import { voiceStatus } from '@/lib/voice';
import { providerStatus } from '@/lib/ai/provider';
import { SparkIcon } from '@/components/ui/icons';

export const metadata: Metadata = {
  title: 'Demo · ShopiQ',
  description: 'A guided walkthrough of ShopiQ, with measured evaluation results.',
};
export const dynamic = 'force-dynamic';

/**
 * Demo mode.
 *
 * Two rules govern this page:
 *
 *   1. It is labelled DEMO MODE at the top, unmissably.
 *   2. Every number on it is measured. The evaluation figures are read from
 *      `eval/results.json`, written by an actual run of `npm run eval`; the
 *      commerce figures come from the live database. If a file or a figure is
 *      missing, the page says so rather than substituting something plausible.
 *
 * A demo that quietly shows invented metrics is worse than no demo, because it
 * is the one context where nobody checks.
 */

interface EvalResults {
  generatedAt: string;
  suites: Record<
    string,
    { name: string; score: number | null; correct: number; partial: number; incorrect: number; total: number }
  >;
  latency: {
    chatAvgMs: number | null;
    chatP95Ms: number | null;
    sttAvgMs: number | null;
    ttsAvgMs: number | null;
    chatSamples: number;
    sttSamples: number;
    ttsSamples: number;
  };
}

async function loadEvalResults(): Promise<EvalResults | null> {
  try {
    const file = await readFile(path.join(process.cwd(), 'eval', 'results.json'), 'utf8');
    return JSON.parse(file) as EvalResults;
  } catch {
    // No run yet. The page says so; it does not invent scores.
    return null;
  }
}

function Metric({
  label,
  value,
  hint,
  strong = false,
}: {
  label: string;
  value: string;
  hint?: string;
  strong?: boolean;
}) {
  return (
    <div className="rounded-[14px] border border-white/8 bg-[#0C0C0F] px-4 py-3.5">
      <div className="text-[11px] uppercase tracking-wide text-[#7E7E88]">{label}</div>
      <div
        className={[
          'mt-1 text-[22px] font-semibold tabular-nums',
          strong ? 'text-[#F7931E]' : 'text-white',
        ].join(' ')}
      >
        {value}
      </div>
      {hint ? <div className="mt-0.5 text-[11.5px] text-[#8A8A93]">{hint}</div> : null}
    </div>
  );
}

const SCRIPT: Array<{ say: string; then: string }> = [
  {
    say: 'Mujhe programming aur gaming ke liye laptop chahiye, budget around 80k hai.',
    then: 'Extracts category, budget and both use cases, searches the real catalogue, ranks deterministically.',
  },
  {
    say: 'Pehla aur second wala compare karo.',
    then: 'Resolves both ordinals against what was shown and returns an aligned comparison.',
  },
  {
    say: 'Pehla wala cart mein daal do.',
    then: 'Adds it. Price and stock are re-read server-side; the website cart updates in the same breath.',
  },
  {
    say: 'College ke liye bag bhi chahiye.',
    then: 'Cross-sells from real category pairings, scored on price proportionality and availability.',
  },
  {
    say: "What's my total?",
    then: 'Backend-authoritative total. The model never computes money.',
  },
  {
    say: "I'm ready to buy.",
    then: 'Re-validates prices, stock and the cart, then quotes an exact total and asks.',
  },
  {
    say: 'Yes.',
    then: 'Seventeen checks, then a Razorpay TEST order. Payment is verified server-side before any order exists.',
  },
];

export default async function DemoPage() {
  const [results, stats] = await Promise.all([loadEvalResults(), getAiCommerceStats(30)]);
  const payments = paymentStatus();
  const voice = voiceStatus();
  const ai = providerStatus();

  const suite = (key: string) => results?.suites?.[key] ?? null;
  const score = (key: string) => {
    const found = suite(key);
    return found?.score === null || found?.score === undefined ? 'N/A' : `${found.score}%`;
  };
  const of = (key: string) => {
    const found = suite(key);
    return found ? `${found.correct}/${found.total} cases` : 'not run';
  };

  return (
    <div className="mx-auto w-full max-w-5xl px-5 py-10 sm:px-6 lg:px-8">
      {/* ------------------------------------------------------ demo badge */}
      <div className="mb-7 flex flex-wrap items-center gap-3 rounded-[14px] border border-[rgba(247,147,30,.35)] bg-[rgba(247,147,30,.07)] px-4 py-3">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[#F7931E] px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-[#1A0D02]">
          Demo mode
        </span>
        <p className="min-w-0 flex-1 text-[12.5px] leading-snug text-[#C6C6CC]">
          Payments run in <strong className="text-white">Razorpay Test Mode</strong> — no money
          moves. Every figure below is measured from a real run; nothing on this page is simulated.
        </p>
      </div>

      <header className="mb-9 max-w-2xl">
        <h1 className="text-[32px] font-semibold leading-tight tracking-tight text-white sm:text-[38px]">
          Don&apos;t search for what to buy.
          <br />
          <span className="brand-text">Just tell ShopiQ what you need.</span>
        </h1>
        <p className="mt-3 text-[14.5px] leading-relaxed text-[#9A9AA3]">
          An AI commerce agent that understands the request, finds real products, compares them,
          builds the cart, and takes payment — with the customer authorising every rupee.
        </p>
      </header>

      {/* ------------------------------------------------------- the script */}
      <section className="mb-10">
        <h2 className="mb-3 text-[15px] font-semibold text-white">The walkthrough</h2>
        <ol className="space-y-2.5">
          {SCRIPT.map((step, index) => (
            <li
              key={step.say}
              className="rounded-[14px] border border-white/8 bg-[#0C0C0F] px-4 py-3.5"
            >
              <div className="flex items-start gap-3">
                <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-white/8 text-[11px] font-semibold text-[#C6C6CC]">
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <p className="text-[14px] font-medium text-white">“{step.say}”</p>
                  <p className="mt-1 text-[12.5px] leading-snug text-[#8A8A93]">{step.then}</p>
                </div>
              </div>
            </li>
          ))}
        </ol>

        <Link
          href="/"
          className="mt-5 inline-flex h-11 items-center gap-2 rounded-full brand-gradient px-6 text-[14px] font-semibold text-[#1A0D02] transition-[filter] hover:brightness-107"
        >
          <SparkIcon size={16} />
          Start the demo
        </Link>
      </section>

      {/* ------------------------------------------------- measured results */}
      <section className="mb-10">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[15px] font-semibold text-white">Measured evaluation</h2>
          {results ? (
            <span className="text-[11.5px] text-[#7E7E88]">
              run {new Date(results.generatedAt).toLocaleString('en-IN')}
            </span>
          ) : null}
        </div>

        {!results ? (
          <p className="rounded-[14px] border border-white/8 bg-[#0C0C0F] px-5 py-6 text-[13px] text-[#8A8A93]">
            No evaluation has been run yet. Run <code className="text-[#C6C6CC]">npm run eval</code>{' '}
            to generate <code className="text-[#C6C6CC]">eval/results.json</code>; this section
            stays empty rather than showing placeholder scores.
          </p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Metric label="Requirement accuracy" value={score('extraction')} hint={of('extraction')} />
              <Metric label="Search relevance" value={score('search')} hint={of('search')} />
              <Metric label="Reference resolution" value={score('references')} hint={of('references')} />
              <Metric label="Tool selection" value={score('tools')} hint={of('tools')} />
              <Metric label="Payment safety" value={score('payment')} hint={of('payment')} strong />
              <Metric label="Injection resistance" value={score('injection')} hint={of('injection')} strong />
              <Metric
                label="Avg AI latency"
                value={
                  results.latency.chatAvgMs === null ? 'N/A' : `${results.latency.chatAvgMs} ms`
                }
                hint={
                  results.latency.chatP95Ms
                    ? `p95 ${results.latency.chatP95Ms} ms · ${results.latency.chatSamples} samples`
                    : undefined
                }
              />
              <Metric
                label="Avg voice latency"
                value={
                  results.latency.sttAvgMs === null && results.latency.ttsAvgMs === null
                    ? 'N/A'
                    : `${(results.latency.sttAvgMs ?? 0) + (results.latency.ttsAvgMs ?? 0)} ms`
                }
                hint={
                  results.latency.sttAvgMs === null
                    ? 'no voice samples'
                    : `STT ${results.latency.sttAvgMs} ms + TTS ${results.latency.ttsAvgMs ?? 0} ms`
                }
              />
            </div>
            <p className="mt-3 text-[11.5px] leading-relaxed text-[#6E6E76]">
              Scores award full credit for a correct case and half for a partial one. Payment safety
              is the one suite that must be 100% — the evaluation exits non-zero if it is not.
            </p>
          </>
        )}
      </section>

      {/* ------------------------------------------------- commerce figures */}
      <section className="mb-10">
        <h2 className="mb-3 text-[15px] font-semibold text-white">Live commerce (last 30 days)</h2>
        {stats.empty ? (
          <p className="rounded-[14px] border border-white/8 bg-[#0C0C0F] px-5 py-6 text-[13px] text-[#8A8A93]">
            No AI commerce data yet. These figures are attributed from real orders, so they stay
            empty until a purchase actually happens.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="AI conversations" value={String(stats.conversations)} />
            <Metric
              label="AI-assisted conversion"
              value={stats.aiConversion.value === null ? 'N/A' : `${stats.aiConversion.value}%`}
              hint={`${stats.aiConversion.numerator}/${stats.aiConversion.denominator} sessions`}
            />
            <Metric
              label="Cross-sell conversion"
              value={
                stats.crossSell.purchaseRate.value === null
                  ? 'N/A'
                  : `${stats.crossSell.purchaseRate.value}%`
              }
              hint={`${stats.crossSell.purchased}/${stats.crossSell.shown} shown`}
            />
            <Metric
              label="AI-assisted revenue"
              value={formatPrice(stats.aiRevenue)}
              hint={`of ${formatPrice(stats.totalRevenue)}`}
              strong
            />
          </div>
        )}
      </section>

      {/* ----------------------------------------------------- environment */}
      <section>
        <h2 className="mb-3 text-[15px] font-semibold text-white">This environment</h2>
        <dl className="grid gap-2 sm:grid-cols-3">
          {[
            {
              term: 'AI provider',
              value: ai.available ? ai.provider : 'deterministic (no key)',
            },
            {
              term: 'Payments',
              value:
                payments.provider === 'razorpay'
                  ? payments.testMode
                    ? 'Razorpay — TEST mode'
                    : 'Razorpay — LIVE'
                  : 'deterministic mock (no keys)',
            },
            {
              term: 'Voice',
              value: voice.live ? `Sarvam · ${voice.sttModel}` : 'deterministic mock (no key)',
            },
          ].map((item) => (
            <div
              key={item.term}
              className="rounded-[12px] border border-white/8 bg-[#0C0C0F] px-4 py-3"
            >
              <dt className="text-[11px] uppercase tracking-wide text-[#7E7E88]">{item.term}</dt>
              <dd className="mt-1 text-[13.5px] text-white">{item.value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 text-[12px] leading-relaxed text-[#6E6E76]">
          ShopiQ cannot take a live payment in this environment, and the assistant has no tool that
          could place an order without a fresh human confirmation. Both are structural, not
          configuration — see the audit trail in the merchant panel for the evidence.
        </p>
      </section>
    </div>
  );
}
