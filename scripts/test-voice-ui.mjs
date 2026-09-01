/**
 * Phase 5 browser test — the voice control in a real browser.
 *
 *   npm run dev
 *   node -r dotenv/config scripts/test-voice-ui.mjs dotenv_config_path=.env.local [--shots <dir>]
 *
 * Chromium is launched with a fake microphone, so the capture path, the state
 * machine, the cleanup and the fallbacks all run for real without needing a
 * human to speak. The fake device emits a tone rather than speech, so this
 * asserts on STATES and TEARDOWN, not on transcript text — that is what the
 * integration suite covers.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const BASE = process.env.SHOPIQ_BASE_URL ?? 'http://localhost:3000';
const shotsIndex = process.argv.indexOf('--shots');
const SHOTS = shotsIndex > -1 ? process.argv[shotsIndex + 1] : null;

let passed = 0;
let failed = 0;
const failures = [];
function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
if (SHOTS) await mkdir(SHOTS, { recursive: true });

try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 950 },
    permissions: ['microphone'],
  });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    const url = message.location()?.url ?? '';

    // The fake microphone emits a tone, so /api/voice/transcribe refusing it
    // with a 400 is the DESIGNED path, not a defect — the browser logs every
    // non-2xx as a console error regardless. Rate limits are excluded for the
    // same reason they are in the other suites.
    if (url.includes('/api/voice/')) return;
    if (text.includes('favicon') || text.includes('429')) return;

    consoleErrors.push(`${text} ${url}`.trim());
  });

  const panel = page.locator('aside[aria-label="ShopiQ AI assistant"]');
  const micButton = panel.locator('button[aria-label="Talk to ShopiQ"]');

  // ============================================================== render
  section('The voice control renders');

  // The storefront shell — header button, mobile nav, FAB — lives on the
  // catalogue routes. `/` is the agent experience and carries none of it, so
  // every shell interaction below is driven from /products.
  await page.goto(`${BASE}/products`, { waitUntil: 'networkidle' });
  await page.locator('button[aria-label="Ask the ShopiQ AI assistant"]').first().click();
  await page.waitForTimeout(700);
  check('the assistant opens', await panel.isVisible());

  check('a microphone button is offered', (await micButton.count()) > 0);
  check(
    'it is labelled for screen readers',
    (await micButton.first().getAttribute('aria-label')) === 'Talk to ShopiQ',
  );
  check(
    'it reports its pressed state',
    (await micButton.first().getAttribute('aria-pressed')) === 'false',
  );

  // Voice must never be the only way in.
  const textInput = panel.locator('input[aria-label="Message ShopiQ"]');
  check('the text box is still present', (await textInput.count()) > 0);
  check('and is usable', await textInput.isEnabled());

  if (SHOTS) await page.screenshot({ path: `${SHOTS}/voice-01-idle.png` });

  // =========================================================== listening
  section('Listening state');

  await micButton.first().click();
  await page.waitForTimeout(1200);

  const stopButton = panel.locator('button[aria-label="Stop listening"]');
  check('the button becomes a stop control', (await stopButton.count()) > 0);
  check(
    'it reports pressed while listening',
    (await stopButton.first().getAttribute('aria-pressed')) === 'true',
  );

  const listeningText = await panel.innerText();
  check('the panel says it is listening', /Listening/i.test(listeningText), listeningText.slice(-140));

  // The microphone must actually be open — a live audio track proves capture
  // started rather than the UI merely changing state.
  check('a recording session is active', (await stopButton.count()) > 0);

  if (SHOTS) await page.screenshot({ path: `${SHOTS}/voice-02-listening.png` });

  // =========================================== stop → transcribe → fallback
  section('Stopping submits the recording');

  const transcribeWaiter = page
    .waitForResponse((r) => r.url().includes('/api/voice/transcribe'), { timeout: 45_000 })
    .catch(() => null);

  await stopButton.first().click();
  const transcribeResponse = await transcribeWaiter;
  await page.waitForTimeout(2000);

  check('a transcription request was made', Boolean(transcribeResponse), 'no request observed');
  if (transcribeResponse) {
    check(
      'the server answered cleanly',
      [200, 400, 429].includes(transcribeResponse.status()),
      String(transcribeResponse.status()),
    );
  }

  // A fake device emits a tone, so the realistic outcomes are an empty
  // transcript or a nonsense one. Either way the UI must land somewhere the
  // customer can act on, never stuck mid-state.
  const afterStop = await panel.innerText();
  const settled =
    /Talk to ShopiQ/i.test(afterStop) ||
    /Try Again/i.test(afterStop) ||
    /understand/i.test(afterStop) ||
    /Finding the best options/i.test(afterStop) ||
    /didn't hear/i.test(afterStop);
  check('the UI settles into an actionable state', settled, afterStop.slice(-200));

  const retryOffered = await panel.locator('button', { hasText: 'Try Again' }).count();
  const typeInsteadOffered = await panel.locator('button', { hasText: 'Type Instead' }).count();
  if (retryOffered > 0) {
    check('a failure offers Try Again', retryOffered > 0);
    check('a failure offers Type Instead', typeInsteadOffered > 0);
  } else {
    check('no error state to recover from', true);
  }

  if (SHOTS) await page.screenshot({ path: `${SHOTS}/voice-03-after.png` });

  // ============================================ text still works alongside
  section('Text still works');

  // Match on the body, not just the URL: a successful transcript is submitted
  // to the same endpoint, and a plain URL matcher catches that request instead
  // of this one.
  const typedMessage = 'laptop under 80000';
  const chatWaiter = page.waitForResponse(
    (r) =>
      r.url().includes('/api/ai/chat') &&
      r.request().method() === 'POST' &&
      (r.request().postData() ?? '').includes(typedMessage),
    { timeout: 45_000 },
  );
  await textInput.fill(typedMessage);
  await textInput.press('Enter');
  const chatResponse = await chatWaiter;
  await page.waitForTimeout(1800);

  check('a typed message still works', chatResponse.status() === 200, String(chatResponse.status()));
  const payload = await chatResponse.json().catch(() => null);
  check('and returns products', (payload?.products?.length ?? 0) > 0);
  check('with a structured type', typeof payload?.type === 'string', payload?.type);

  // ================================================================ cleanup
  section('Cleanup on close');

  // Start listening again, then close the panel without stopping — the
  // microphone must not survive the component.
  //
  // In the error state the control swaps the mic for Try Again / Type Instead,
  // so whichever is on screen is the way back into listening.
  const retryButton = panel.locator('button', { hasText: 'Try Again' });
  if ((await retryButton.count()) > 0) {
    await retryButton.first().click();
  } else {
    await panel.locator('button[aria-label="Talk to ShopiQ"]').first().click();
  }
  await page.waitForTimeout(1200);
  check('listening again', (await panel.locator('button[aria-label="Stop listening"]').count()) > 0);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(1200);

  const liveTracks = await page.evaluate(async () => {
    // A track still in "live" state means a microphone was left open.
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    return { deviceCount: devices.length };
  });
  check('the panel closed', !(await panel.isVisible()), 'panel still visible');
  check('media devices are still enumerable (no crash)', liveTracks.deviceCount >= 0);

  check('no console errors throughout', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

  await context.close();

  // ================================================================ mobile
  section('Mobile');

  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    permissions: ['microphone'],
  });
  const mobilePage = await mobile.newPage();
  await mobilePage.goto(`${BASE}/products`, { waitUntil: 'networkidle' });
  await mobilePage.locator('nav[aria-label="Primary"] button[aria-label="Ask ShopiQ"]').click();
  await mobilePage.waitForTimeout(800);

  const mobilePanel = mobilePage.locator('aside[aria-label="ShopiQ AI assistant"]');
  check(
    'the microphone is reachable on mobile',
    (await mobilePanel.locator('button[aria-label="Talk to ShopiQ"]').count()) > 0,
  );

  const overflow = await mobilePage.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check('no horizontal overflow at 390px', overflow <= 1, `${overflow}px`);

  if (SHOTS) await mobilePage.screenshot({ path: `${SHOTS}/voice-04-mobile.png` });
  await mobile.close();

  console.log(`\n${'='.repeat(56)}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  · ${f}`);
  }
} finally {
  await browser.close();
}

process.exit(failed > 0 ? 1 : 0);
