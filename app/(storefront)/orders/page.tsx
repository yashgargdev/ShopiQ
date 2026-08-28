import { redirect } from 'next/navigation';

/**
 * Order history moved to /account/orders.
 *
 * Kept as a redirect rather than deleted: invoice emails link to /orders, and
 * those are already in customers' inboxes.
 */
export default function OrdersRedirect() {
  redirect('/account/orders');
}
