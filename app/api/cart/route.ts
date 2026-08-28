import { jsonOk, withErrorHandling } from '@/lib/api/response';
import { clearCart, getCart } from '@/lib/cart/queries';

/** GET /api/cart — the caller's cart, priced from the live catalogue. */
export const GET = withErrorHandling(async () => {
  const cart = await getCart();
  return jsonOk({ cart }, { headers: { 'Cache-Control': 'no-store' } });
});

/** DELETE /api/cart — empty the cart. */
export const DELETE = withErrorHandling(async () => {
  const cart = await clearCart();
  return jsonOk({ cart }, { headers: { 'Cache-Control': 'no-store' } });
});
