import { jsonOk, withErrorHandling } from '@/lib/api/response';
import { listCategories } from '@/lib/products/queries';

/**
 * GET /api/categories
 *
 * Active categories with their product counts. Parents report the sum of their
 * children, and carry a nested `children` array so a nav can be built in one
 * request.
 */
export const GET = withErrorHandling(async () => {
  const categories = await listCategories();

  return jsonOk(
    {
      categories: categories.map((category) => ({
        id: category.id,
        name: category.name,
        slug: category.slug,
        description: category.description,
        imageUrl: category.imageUrl,
        parentId: category.parentId,
        productCount: category.productCount ?? 0,
        children: (category.children ?? []).map((child) => ({
          id: child.id,
          name: child.name,
          slug: child.slug,
          productCount: child.productCount ?? 0,
        })),
      })),
    },
    { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=900' } },
  );
});
