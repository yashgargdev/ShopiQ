import { jsonOk, withErrorHandling } from '@/lib/api/response';
import { requireMerchant } from '@/lib/auth';
import { getDashboardStats } from '@/lib/merchant/queries';

/**
 * GET /api/merchant/analytics
 *
 * Every figure is computed from real rows. With no orders yet, the counts come
 * back as zero and the UI shows an empty state rather than invented numbers.
 */
export const GET = withErrorHandling(async () => {
  await requireMerchant();
  const stats = await getDashboardStats();
  return jsonOk({ stats }, { headers: { 'Cache-Control': 'no-store' } });
});
