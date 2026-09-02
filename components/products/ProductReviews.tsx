import { aspectLabel, listProductReviews, summariseProductReviews } from '@/lib/reviews/queries';
import { Rating } from '@/components/ui/primitives';
import { formatNumber } from '@/lib/format';

/**
 * Reviews on a product page.
 *
 * Labelled as demonstration data, in the page and not only in a comment.
 * Fabricated praise presented as real customer feedback is precisely the thing
 * a shopping assistant exists to protect people from, so the label is part of
 * the component rather than something a caller can forget to pass.
 */
export async function ProductReviews({ productId }: { productId: string }) {
  const [summary, reviews] = await Promise.all([
    summariseProductReviews(productId),
    listProductReviews(productId, 6),
  ]);

  if (!summary || reviews.length === 0) return null;

  const bars = ([5, 4, 3, 2, 1] as const).map((star) => ({
    star,
    count: summary.distribution[star],
    share: summary.count === 0 ? 0 : (summary.distribution[star] / summary.count) * 100,
  }));

  return (
    <section className="mt-16">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="m-0 text-[20px] font-semibold tracking-[-0.02em]">
          What buyers said
        </h2>
        <span className="rounded-full border border-white/12 px-2.5 py-1 text-[11.5px] text-[#8A8A93]">
          Demo reviews — not real customer feedback
        </span>
      </div>

      <div className="mt-6 grid gap-8 lg:grid-cols-[300px_1fr] lg:items-start">
        {/* ------------------------------------------------ the distribution */}
        <div className="rounded-[14px] border border-white/9 bg-[#0C0C0E] p-5">
          <div className="flex items-baseline gap-2.5">
            <span className="text-[34px] font-semibold leading-none text-white">
              {summary.average.toFixed(1)}
            </span>
            <span className="text-[13px] text-[#7E7E88]">out of 5</span>
          </div>
          <div className="mt-2.5">
            <Rating value={summary.average} size={14} />
          </div>
          <p className="m-0 mt-2 text-[12.5px] text-[#7E7E88]">
            {formatNumber(summary.count)} {summary.count === 1 ? 'review' : 'reviews'} ·{' '}
            {Math.round(summary.verifiedShare * 100)}% verified
          </p>

          <div className="mt-4 flex flex-col gap-1.5">
            {bars.map((bar) => (
              <div key={bar.star} className="flex items-center gap-2.5">
                <span className="w-3 text-right font-mono text-[11.5px] text-[#7E7E88]">
                  {bar.star}
                </span>
                <span className="h-[6px] flex-1 overflow-hidden rounded-full bg-white/8">
                  <span
                    className="block h-full rounded-full brand-gradient"
                    style={{ width: `${bar.share}%` }}
                  />
                </span>
                <span className="w-6 text-right font-mono text-[11.5px] text-[#7E7E88]">
                  {bar.count}
                </span>
              </div>
            ))}
          </div>

          {(summary.praised.length > 0 || summary.criticised.length > 0) && (
            <div className="mt-5 flex flex-col gap-3 border-t border-white/8 pt-4">
              {summary.praised.length > 0 ? (
                <div>
                  <p className="m-0 text-[11.5px] font-semibold uppercase tracking-[0.1em] text-[#6E6E76]">
                    Praised for
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {summary.praised.map((entry) => (
                      <span
                        key={entry.aspect}
                        className="rounded-full border border-[rgba(46,160,67,.35)] bg-[rgba(46,160,67,.1)] px-2.5 py-1 text-[12px] text-[#7EE787]"
                      >
                        {aspectLabel(entry.aspect)} · {entry.positive}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}

              {summary.criticised.length > 0 ? (
                <div>
                  <p className="m-0 text-[11.5px] font-semibold uppercase tracking-[0.1em] text-[#6E6E76]">
                    Criticised for
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {summary.criticised.map((entry) => (
                      <span
                        key={entry.aspect}
                        className="rounded-full border border-[rgba(248,81,73,.32)] bg-[rgba(248,81,73,.09)] px-2.5 py-1 text-[12px] text-[#FF9B95]"
                      >
                        {aspectLabel(entry.aspect)} · {entry.negative}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>

        {/* ----------------------------------------------------- the reviews */}
        <ul className="m-0 flex list-none flex-col gap-4 p-0">
          {reviews.map((review) => (
            <li
              key={review.id}
              className="rounded-[14px] border border-white/9 bg-[#0C0C0E] p-5"
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <Rating value={review.rating} size={13} />
                {review.title ? (
                  <span className="text-[14.5px] font-semibold text-white">{review.title}</span>
                ) : null}
              </div>
              <p className="m-0 mt-2.5 text-[14px] leading-[1.65] text-[#B4B4BE]">{review.body}</p>
              <p className="m-0 mt-3 text-[12px] text-[#6E6E76]">
                {review.authorName}
                {review.isVerifiedPurchase ? ' · Verified purchase' : ''} ·{' '}
                {new Date(review.createdAt).toLocaleDateString('en-IN', {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                })}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
