import { jsonOk, withErrorHandling } from '@/lib/api/response';
import { prepareCheckout } from '@/lib/checkout/prepare';

/**
 * POST /api/cart/prepare-checkout
 *
 * Validates and prices the current cart and returns a preview. It creates
 * nothing: no order, no reservation, no payment. The AI tool `prepare_checkout`
 * calls the same service, so the assistant and the website cannot disagree
 * about the total.
 *
 * POST rather than GET because it is the deliberate "I'm ready to buy" step,
 * and should never be cached or prefetched.
 */
export const POST = withErrorHandling(async () => {
  const preview = await prepareCheckout();

  return jsonOk(
    {
      checkout: {
        ...preview,
        // Stated on the wire so no caller has to infer the boundary from
        // the absence of an order id.
        creates_order: false,
        creates_payment: false,
      },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
});
