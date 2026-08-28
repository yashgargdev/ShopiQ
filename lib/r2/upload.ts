import 'server-only';

import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

import { R2_BUCKET, publicUrlForKey, r2Client } from './client';

/** Only formats a browser can render in an <img>, and that we can sniff. */
export const ALLOWED_IMAGE_TYPES = [
  'image/webp',
  'image/png',
  'image/jpeg',
  'image/avif',
  'image/svg+xml',
] as const;

export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number];

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB

const EXTENSION_BY_TYPE: Record<AllowedImageType, string> = {
  'image/webp': 'webp',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
};

export class UploadValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadValidationError';
  }
}

/**
 * Strip everything that could escape the intended prefix or confuse a CDN:
 * path separators, traversal, control characters, leading dots.
 */
export function safeFilename(input: string, fallback = 'image'): string {
  const base = (input.split(/[\\/]/).pop() ?? '')
    .normalize('NFKD')
    .replace(/\.[^.]*$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || fallback;
}

export function buildProductImageKey(
  productId: string,
  filename: string,
  contentType: AllowedImageType,
): string {
  if (!/^[0-9a-f-]{36}$/i.test(productId)) {
    throw new UploadValidationError('Invalid product id');
  }
  // A short random suffix keeps re-uploads of the same filename from silently
  // overwriting an image that other rows still reference.
  const suffix = Math.random().toString(36).slice(2, 8);
  const name = safeFilename(filename);
  return `products/${productId}/${name}-${suffix}.${EXTENSION_BY_TYPE[contentType]}`;
}

/**
 * Sniff the real content type from the leading bytes. A client-supplied MIME
 * type is a hint, not evidence — this is what actually decides.
 */
export function detectImageType(bytes: Uint8Array): AllowedImageType | null {
  if (bytes.length < 12) return null;

  const startsWith = (sig: number[], offset = 0) =>
    sig.every((byte, i) => bytes[offset + i] === byte);

  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) {
    return 'image/webp';
  }
  if (startsWith([0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = new TextDecoder().decode(bytes.slice(8, 12));
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
  }

  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.slice(0, 400))
    .trimStart()
    .toLowerCase();
  if (head.startsWith('<?xml') || head.startsWith('<svg')) return 'image/svg+xml';

  return null;
}

export interface UploadedObject {
  key: string;
  publicUrl: string;
  contentType: AllowedImageType;
  size: number;
}

export async function uploadProductImage(params: {
  productId: string;
  filename: string;
  body: Uint8Array;
  declaredType?: string;
}): Promise<UploadedObject> {
  const { productId, filename, body } = params;

  if (body.length === 0) {
    throw new UploadValidationError('File is empty');
  }
  if (body.length > MAX_IMAGE_BYTES) {
    throw new UploadValidationError(
      `File is larger than ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB`,
    );
  }

  const contentType = detectImageType(body);
  if (!contentType) {
    throw new UploadValidationError(
      'Unsupported file. Upload a WebP, PNG, JPEG, AVIF or SVG image.',
    );
  }

  const key = buildProductImageKey(productId, filename, contentType);

  await r2Client().send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
    }),
  );

  return { key, publicUrl: publicUrlForKey(key), contentType, size: body.length };
}

export async function deleteObject(key: string): Promise<void> {
  await r2Client().send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
}

export async function getObject(key: string) {
  return r2Client().send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
}
