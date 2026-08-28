import { NextResponse } from 'next/server';

import { getObject } from '@/lib/r2/upload';

export const runtime = 'nodejs';

/**
 * GET /api/media/<object key>
 *
 * Fallback image delivery for deployments where the R2 bucket is not exposed
 * on a public domain. When R2_PUBLIC_URL is set, product_images.public_url
 * points straight at the CDN and this route is never hit.
 *
 * Only the products/ prefix is served, so this cannot be used to read
 * arbitrary objects out of the bucket.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ key: string[] }> },
) {
  const { key: segments } = await context.params;
  const key = segments.map(decodeURIComponent).join('/');

  if (!key.startsWith('products/') || key.includes('..')) {
    return new NextResponse('Not found', { status: 404 });
  }

  try {
    const object = await getObject(key);
    const body = await object.Body?.transformToByteArray();
    if (!body) return new NextResponse('Not found', { status: 404 });

    return new NextResponse(Buffer.from(body), {
      headers: {
        'Content-Type': object.ContentType ?? 'application/octet-stream',
        'Content-Length': String(body.length),
        'Cache-Control': 'public, max-age=31536000, immutable',
        // Objects here are user-uploaded; keep any embedded script inert.
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return new NextResponse('Not found', { status: 404 });
  }
}
