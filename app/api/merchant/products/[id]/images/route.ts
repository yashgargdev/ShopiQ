import type { NextRequest } from 'next/server';

import { badRequest, jsonOk, notFound, withErrorHandling, ApiError } from '@/lib/api/response';
import { requireMerchant } from '@/lib/auth';
import { adminClient } from '@/lib/supabase/admin';
import { isR2Configured } from '@/lib/r2/client';
import {
  MAX_IMAGE_BYTES,
  UploadValidationError,
  deleteObject,
  uploadProductImage,
} from '@/lib/r2/upload';
import { uuidSchema } from '@/lib/validation/schemas';

export const runtime = 'nodejs';

/**
 * POST /api/merchant/products/:id/images
 *
 * multipart/form-data with a `file` field. The bytes go to Cloudflare R2 and
 * only the resulting key and public URL are stored in Postgres — no binaries
 * in the database.
 *
 * The R2 credentials stay in this process. The browser never signs anything.
 */
export const POST = withErrorHandling(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    await requireMerchant();

    if (!isR2Configured()) {
      throw new ApiError(
        'INTERNAL_ERROR',
        'Image storage is not configured. Set the R2_* environment variables.',
      );
    }

    const { id } = await context.params;
    const productId = uuidSchema.parse(id);

    const db = adminClient();
    const { data: product } = await db
      .from('products')
      .select('id, name')
      .eq('id', productId)
      .maybeSingle();
    if (!product) throw notFound('Product not found.');

    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.includes('multipart/form-data')) {
      throw badRequest('Send the image as multipart/form-data with a "file" field.');
    }

    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      throw badRequest('No file was uploaded.');
    }
    // Reject on the declared size before buffering the whole body.
    if (file.size > MAX_IMAGE_BYTES) {
      throw new ApiError(
        'PAYLOAD_TOO_LARGE',
        `Images must be ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB or smaller.`,
      );
    }

    const bytes = new Uint8Array(await file.arrayBuffer());

    let uploaded;
    try {
      uploaded = await uploadProductImage({
        productId,
        filename: file.name || 'image',
        body: bytes,
        declaredType: file.type,
      });
    } catch (error) {
      if (error instanceof UploadValidationError) throw badRequest(error.message);
      throw error;
    }

    const altText = (form.get('altText') as string | null)?.trim() || (product.name as string);
    const makePrimary = form.get('isPrimary') === 'true';

    const { count } = await db
      .from('product_images')
      .select('id', { count: 'exact', head: true })
      .eq('product_id', productId);

    const isFirstImage = (count ?? 0) === 0;
    const shouldBePrimary = makePrimary || isFirstImage;

    // Only one image per product may be primary (enforced by a partial unique
    // index), so stand the old one down first.
    if (shouldBePrimary) {
      await db
        .from('product_images')
        .update({ is_primary: false })
        .eq('product_id', productId)
        .eq('is_primary', true);
    }

    const { data: image, error } = await db
      .from('product_images')
      .insert({
        product_id: productId,
        r2_key: uploaded.key,
        public_url: uploaded.publicUrl,
        alt_text: altText,
        sort_order: count ?? 0,
        is_primary: shouldBePrimary,
      })
      .select('id, public_url, r2_key, alt_text, is_primary, sort_order')
      .single();

    if (error) {
      // Do not leave an orphan object behind in the bucket.
      await deleteObject(uploaded.key).catch(() => undefined);
      throw error;
    }

    return jsonOk(
      { image, size: uploaded.size, contentType: uploaded.contentType },
      { status: 201, headers: { 'Cache-Control': 'no-store' } },
    );
  },
);

/** DELETE /api/merchant/products/:id/images?imageId=... */
export const DELETE = withErrorHandling(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    await requireMerchant();

    const { id } = await context.params;
    const productId = uuidSchema.parse(id);
    const imageId = uuidSchema.parse(request.nextUrl.searchParams.get('imageId') ?? '');

    const db = adminClient();
    const { data: image } = await db
      .from('product_images')
      .select('id, r2_key, is_primary')
      .eq('id', imageId)
      .eq('product_id', productId)
      .maybeSingle();

    if (!image) throw notFound('Image not found.');

    await db.from('product_images').delete().eq('id', imageId);
    await deleteObject(image.r2_key as string).catch(() => undefined);

    // Promote the next image so the product is never left without a cover.
    if (image.is_primary) {
      const { data: next } = await db
        .from('product_images')
        .select('id')
        .eq('product_id', productId)
        .order('sort_order', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (next) {
        await db.from('product_images').update({ is_primary: true }).eq('id', next.id);
      }
    }

    return jsonOk({ deleted: true }, { headers: { 'Cache-Control': 'no-store' } });
  },
);
