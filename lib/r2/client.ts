import 'server-only';

import { S3Client } from '@aws-sdk/client-s3';

/**
 * Cloudflare R2 speaks the S3 API. Everything in this module is server-only —
 * the secret access key must never reach a bundle that ships to the browser.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const R2_BUCKET = process.env.R2_BUCKET_NAME ?? 'shopiq';

/**
 * Public base for objects in the bucket. When it is empty, images are served
 * through ShopiQ's own /api/media proxy instead, so the bucket can stay
 * private.
 */
export const R2_PUBLIC_BASE = (process.env.R2_PUBLIC_URL ?? '').replace(/\/+$/, '');

let cached: S3Client | null = null;

export function r2Client(): S3Client {
  if (cached) return cached;

  cached = new S3Client({
    region: 'auto',
    endpoint: `https://${required('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: required('R2_ACCESS_KEY_ID'),
      secretAccessKey: required('R2_SECRET_ACCESS_KEY'),
    },
  });
  return cached;
}

export function isR2Configured(): boolean {
  return Boolean(
    process.env.R2_ACCOUNT_ID &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY &&
      process.env.R2_BUCKET_NAME,
  );
}

/**
 * Resolve an object key to a URL the browser can load. Prefers the configured
 * CDN/custom domain and falls back to the in-app proxy.
 */
export function publicUrlForKey(key: string): string {
  const normalised = key.replace(/^\/+/, '');
  if (R2_PUBLIC_BASE) {
    const base = R2_PUBLIC_BASE.startsWith('http') ? R2_PUBLIC_BASE : `https://${R2_PUBLIC_BASE}`;
    return `${base}/${normalised}`;
  }
  return `/api/media/${normalised}`;
}
