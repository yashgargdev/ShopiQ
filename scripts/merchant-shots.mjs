/**
 * Screenshots the merchant panel. Creates a throwaway merchant, captures the
 * screens, then deletes the account.
 *
 *   node -r dotenv/config scripts/merchant-shots.mjs dotenv_config_path=.env.local <out-dir>
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const BASE = process.env.SHOPIQ_BASE_URL ?? 'http://localhost:3000';
const SB = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const OUT = process.argv[process.argv.length - 1].endsWith('.mjs')
  ? './merchant-shots'
  : process.argv[process.argv.length - 1];

const admin = createClient(SB, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const email = `shot-${Date.now()}@example.com`;
const password = 'ShopiQ-Test-1234';

await mkdir(OUT, { recursive: true });

const { data: user, error } = await admin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
  user_metadata: { full_name: 'Yash Garg' },
});
if (error) throw error;

await admin
  .from('merchant_users')
  .insert({ id: user.user.id, email, full_name: 'Yash Garg', role: 'owner' });

const { data: signIn } = await createClient(SB, ANON, {
  auth: { persistSession: false },
}).auth.signInWithPassword({ email, password });

const ref = new globalThis.URL(SB).hostname.split('.')[0];
const payload = `base64-${Buffer.from(JSON.stringify(signIn.session)).toString('base64')}`;
const CHUNK = 3180;
const cookies = [];
if (payload.length <= CHUNK) {
  cookies.push({
    name: `sb-${ref}-auth-token`,
    value: encodeURIComponent(payload),
    domain: 'localhost',
    path: '/',
  });
} else {
  for (let i = 0; i * CHUNK < payload.length; i++) {
    cookies.push({
      name: `sb-${ref}-auth-token.${i}`,
      value: encodeURIComponent(payload.slice(i * CHUNK, (i + 1) * CHUNK)),
      domain: 'localhost',
      path: '/',
    });
  }
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addCookies(cookies);
const page = await context.newPage();

for (const [name, path] of [
  ['m-overview', '/merchant'],
  ['m-products', '/merchant/products'],
  ['m-inventory', '/merchant/inventory'],
  ['m-orders', '/merchant/orders'],
  ['m-analytics', '/merchant/analytics'],
]) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`${path} → ${name}.png (overflow ${overflow}px)`);
}

await browser.close();
await admin.auth.admin.deleteUser(user.user.id);
console.log('cleaned up');
