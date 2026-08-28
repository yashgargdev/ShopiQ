/**
 * Verifies the R2 credentials and reports whether the configured public base
 * URL actually serves objects, so `npm run db:seed` can pick the right
 * public_url form for product images.
 *
 *   node scripts/check-r2.mjs
 */
import 'dotenv/config';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET_NAME = 'shopiq',
} = process.env;

if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
  console.error('Missing R2 credentials in .env.local');
  process.exit(1);
}

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
});

const key = `_healthcheck/${Date.now()}.svg`;
const body = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#F7931E"/></svg>',
);

async function main() {
  process.stdout.write('PUT   … ');
  await client.send(
    new PutObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key, Body: body, ContentType: 'image/svg+xml' }),
  );
  console.log('ok');

  process.stdout.write('GET   … ');
  const got = await client.send(new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
  const bytes = await got.Body.transformToByteArray();
  console.log(`ok (${bytes.length} bytes, ${got.ContentType})`);

  for (const base of ['https://cdn.shopiq.yashgarg.co.in']) {
    process.stdout.write(`PUBLIC ${base} … `);
    try {
      const res = await fetch(`${base}/${key}`, { redirect: 'follow' });
      console.log(`HTTP ${res.status} ${res.headers.get('content-type') ?? ''}`);
    } catch (err) {
      console.log(`unreachable (${err.message})`);
    }
  }

  process.stdout.write('DELETE… ');
  await client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
  console.log('ok');
}

main().catch((err) => {
  console.error('\nR2 check failed:', err.name, '-', err.message);
  process.exit(1);
});
