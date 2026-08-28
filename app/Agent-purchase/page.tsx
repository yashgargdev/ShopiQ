import { redirect } from 'next/navigation';

/**
 * `/Agent-purchase` now lives at `/`.
 *
 * Kept as a permanent redirect rather than deleted: the path was shared,
 * bookmarked and used in earlier demos, and a 404 is a worse answer than
 * simply arriving in the right place.
 */
export default function AgentPurchaseRedirect() {
  redirect('/');
}
