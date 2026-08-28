/**
 * Phase 5 integration tests — the voice endpoints and the shared conversation,
 * against a live server.
 *
 *   npm run dev
 *   node -r dotenv/config scripts/test-voice.mjs dotenv_config_path=.env.local
 *
 * The most important section is the last one. Voice must not weaken any Phase
 * 4 payment control, so it asserts that a spoken "yes" outside a confirmation
 * authorises nothing at all.
 */
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const BASE = process.env.SHOPIQ_BASE_URL ?? 'http://localhost:3000';
const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

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

/** A valid PCM WAV, so audio validation is exercised rather than bypassed. */
function wav(milliseconds = 1200, sampleRate = 16000, tone = true) {
  const samples = Math.round((sampleRate * milliseconds) / 1000);
  const dataBytes = samples * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  if (tone) {
    for (let i = 0; i < samples; i++) {
      buffer.writeInt16LE(Math.round(Math.sin((i / sampleRate) * 2 * Math.PI * 220) * 8000), 44 + i * 2);
    }
  }
  return buffer;
}

function session() {
  const jar = new Map();
  return {
    jar,
    async http(path, init = {}) {
      const cookie = Array.from(jar, ([k, v]) => `${k}=${v}`).join('; ');
      const response = await fetch(`${BASE}${path}`, {
        ...init,
        headers: {
          ...(init.body && typeof init.body === 'string'
            ? { 'Content-Type': 'application/json' }
            : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(init.headers ?? {}),
        },
        redirect: 'manual',
      });
      for (const raw of response.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(';');
        const i = pair.indexOf('=');
        if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
      const type = response.headers.get('content-type') ?? '';
      return {
        status: response.status,
        headers: response.headers,
        payload: type.includes('json') ? await response.json().catch(() => null) : null,
        bytes: type.includes('audio') ? Buffer.from(await response.arrayBuffer()) : null,
      };
    },
    async signIn(email, password) {
      const anon = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        { auth: { persistSession: false } },
      );
      const { data, error } = await anon.auth.signInWithPassword({ email, password });
      if (error) throw new Error(error.message);
      const ref = process.env.NEXT_PUBLIC_SUPABASE_URL.match(/https:\/\/([^.]+)\./)[1];
      const payload = Buffer.from(
        JSON.stringify({
          access_token: data.session.access_token,
          token_type: 'bearer',
          expires_at: data.session.expires_at,
          expires_in: data.session.expires_in,
          refresh_token: data.session.refresh_token,
          user: data.session.user,
        }),
      ).toString('base64');
      jar.set(`sb-${ref}-auth-token`, `base64-${payload}`);
    },
  };
}

const state = { userId: null, conversationIds: [] };

async function cleanup() {
  for (const id of state.conversationIds) {
    await admin.from('ai_tool_logs').delete().eq('conversation_id', id);
    await admin.from('conversation_messages').delete().eq('conversation_id', id);
    await admin.from('conversations').delete().eq('id', id);
  }
  if (state.userId) {
    await admin.from('payment_events').delete().eq('customer_id', state.userId);
    await admin.from('payments').delete().eq('customer_id', state.userId);
    await admin.from('purchase_confirmations').delete().eq('customer_id', state.userId);
    const { data: carts } = await admin.from('carts').select('id').eq('customer_id', state.userId);
    for (const cart of carts ?? []) await admin.from('cart_items').delete().eq('cart_id', cart.id);
    await admin.from('carts').delete().eq('customer_id', state.userId);
    await admin.from('conversations').delete().eq('customer_id', state.userId);
    await admin.auth.admin.deleteUser(state.userId).catch(() => {});
  }
}

process.on('uncaughtException', async (error) => {
  console.error('\nUNCAUGHT:', error);
  await cleanup();
  process.exit(1);
});

try {
  // ============================================================== status
  section('Voice availability');

  const shopper = session();
  const status = await shopper.http('/api/voice/status');
  // Not every deployment exposes a voice status route; the chat status is the
  // authority either way.
  const aiStatus = await shopper.http('/api/ai/status');
  check('the AI status endpoint still answers', aiStatus.status === 200);
  check(
    'no Sarvam credential appears in any status payload',
    !JSON.stringify({ a: aiStatus.payload, b: status.payload }).match(/sarvam[_-]?api|subscription-key/i),
  );

  // ================================================================ TTS
  section('Text to speech');

  const spoken = await shopper.http('/api/voice/synthesize', {
    method: 'POST',
    body: JSON.stringify({ text: 'Maine chhah laptops dhoonde hain.' }),
  });
  check('synthesis succeeds', spoken.status === 200, String(spoken.status));
  check('it returns audio', (spoken.headers.get('content-type') ?? '').startsWith('audio/'), spoken.headers.get('content-type'));
  check('the audio is a real WAV', spoken.bytes?.toString('ascii', 0, 4) === 'RIFF');
  check('the audio is non-trivial', (spoken.bytes?.length ?? 0) > 2000, String(spoken.bytes?.length));
  check('latency is reported', Number(spoken.headers.get('x-voice-latency-ms')) >= 0);
  check(
    'no key leaks in the headers',
    !JSON.stringify([...spoken.headers]).match(/subscription|secret|sk-|api[_-]?key/i),
  );

  const emptyTts = await shopper.http('/api/voice/synthesize', {
    method: 'POST',
    body: JSON.stringify({ text: '   ' }),
  });
  check('empty text is refused', emptyTts.status === 400, String(emptyTts.status));

  const hugeTts = await shopper.http('/api/voice/synthesize', {
    method: 'POST',
    body: JSON.stringify({ text: 'a'.repeat(5000) }),
  });
  check('an over-long line is refused', hugeTts.status === 400, String(hugeTts.status));

  const injectedTts = await shopper.http('/api/voice/synthesize', {
    method: 'POST',
    body: JSON.stringify({ text: 'hi', speakerModel: 'x', apiKey: 'y' }),
  });
  check('unknown fields are rejected', injectedTts.status === 400, String(injectedTts.status));

  // ================================================================ STT
  section('Speech to text');

  const form = new FormData();
  form.append('audio', new Blob([wav(1500)], { type: 'audio/wav' }), 'speech.wav');
  const transcribed = await shopper.http('/api/voice/transcribe', { method: 'POST', body: form });
  check(
    'transcription returns a result or a clean refusal',
    [200, 400].includes(transcribed.status),
    String(transcribed.status),
  );
  if (transcribed.status === 200) {
    state.conversationIds.push(transcribed.payload.conversationId);
    check('a conversation id comes back', Boolean(transcribed.payload?.conversationId));
    check('the audio is not retained', transcribed.payload?.audio_retained === false);
    check('stt latency is reported', typeof transcribed.payload?.latency?.stt_ms === 'number');
  }

  const emptyForm = new FormData();
  const emptyAudio = await shopper.http('/api/voice/transcribe', { method: 'POST', body: emptyForm });
  check('a request with no audio is refused', emptyAudio.status === 400, String(emptyAudio.status));

  const tinyForm = new FormData();
  tinyForm.append('audio', new Blob([Buffer.alloc(64)], { type: 'audio/wav' }), 'tiny.wav');
  const tiny = await shopper.http('/api/voice/transcribe', { method: 'POST', body: tinyForm });
  check('an almost-empty file is refused', tiny.status === 400, String(tiny.status));
  check('and says why', tiny.payload?.error?.details?.reason === 'AUDIO_TOO_SHORT', JSON.stringify(tiny.payload?.error?.details));

  // Magic-byte validation: a script renamed .wav must not reach the provider.
  const fakeForm = new FormData();
  const fake = Buffer.from('<?php system($_GET[0]); ?>'.padEnd(4096, ' '));
  fakeForm.append('audio', new Blob([fake], { type: 'audio/wav' }), 'evil.wav');
  const fakeResult = await shopper.http('/api/voice/transcribe', { method: 'POST', body: fakeForm });
  check('a non-audio file claiming to be a WAV is refused', fakeResult.status === 400, String(fakeResult.status));
  check(
    'rejected on format, not passed upstream',
    fakeResult.payload?.error?.details?.reason === 'AUDIO_UNSUPPORTED',
    JSON.stringify(fakeResult.payload?.error?.details),
  );

  const longForm = new FormData();
  longForm.append('audio', new Blob([wav(45_000)], { type: 'audio/wav' }), 'long.wav');
  const tooLong = await shopper.http('/api/voice/transcribe', { method: 'POST', body: longForm });
  check('an over-long recording is refused', tooLong.status === 400, String(tooLong.status));
  check(
    'and says it was too long',
    tooLong.payload?.error?.details?.reason === 'AUDIO_TOO_LONG',
    JSON.stringify(tooLong.payload?.error?.details),
  );

  // ================================================ shared conversation
  section('Voice and text share one conversation');

  const chat = session();
  const spokenTurn = await chat.http('/api/ai/chat', {
    method: 'POST',
    body: JSON.stringify({
      // A phone, not a laptop: nothing in the catalogue costs under ₹80,000
      // in laptops, and this test is about voice mode rather than the price
      // filter, which ai-unit covers directly.
      message: 'Mujhe camera ke liye phone chahiye, 90 hazaar ke andar',
      inputMode: 'voice',
      language: 'hi-IN',
    }),
  });
  const conversationId = spokenTurn.payload?.conversationId;
  state.conversationIds.push(conversationId);
  check('a voice-mode turn is accepted', spokenTurn.status === 200, String(spokenTurn.status));
  check('it returns products', (spokenTurn.payload?.products?.length ?? 0) > 0);
  check('it carries a structured type', spokenTurn.payload?.type === 'product_recommendations', spokenTurn.payload?.type);
  check('it carries a spoken summary', typeof spokenTurn.payload?.speech === 'string' && spokenTurn.payload.speech.length > 0);
  check(
    'the spoken summary is shorter than the screen text',
    (spokenTurn.payload.speech?.length ?? 0) <= spokenTurn.payload.message.length,
  );

  // A typed follow-up must see the spoken turn.
  const typedFollowUp = await chat.http('/api/ai/chat', {
    method: 'POST',
    body: JSON.stringify({ conversationId, message: 'pehla wala kaisa hai?', inputMode: 'text' }),
  });
  check('a typed follow-up continues the same conversation', typedFollowUp.payload?.conversationId === conversationId);
  check(
    'and resolves the spoken reference',
    typedFollowUp.payload?.outcome !== 'clarify',
    typedFollowUp.payload?.outcome,
  );

  const { data: messages } = await admin
    .from('conversation_messages')
    .select('role, metadata')
    .eq('conversation_id', conversationId)
    .eq('role', 'user')
    .order('created_at');

  check('both turns are in one conversation', (messages ?? []).length === 2, String(messages?.length));
  check('the first is marked voice', messages?.[0]?.metadata?.input_mode === 'voice', JSON.stringify(messages?.[0]?.metadata));
  check('the second is marked text', messages?.[1]?.metadata?.input_mode === 'text', JSON.stringify(messages?.[1]?.metadata));
  check('the detected language is kept', messages?.[0]?.metadata?.language === 'hi-IN');

  // The reverse direction must work too.
  const typedFirst = session();
  const typed = await typedFirst.http('/api/ai/chat', {
    method: 'POST',
    body: JSON.stringify({ message: 'I need headphones under 10000', inputMode: 'text' }),
  });
  state.conversationIds.push(typed.payload?.conversationId);
  const spokenSecond = await typedFirst.http('/api/ai/chat', {
    method: 'POST',
    body: JSON.stringify({
      conversationId: typed.payload.conversationId,
      message: 'which one is better for travel?',
      inputMode: 'voice',
    }),
  });
  check(
    'a spoken follow-up continues a typed conversation',
    spokenSecond.payload?.conversationId === typed.payload.conversationId,
  );
  check('and stays on topic', spokenSecond.status === 200 && Boolean(spokenSecond.payload?.message));

  const injectedMode = await chat.http('/api/ai/chat', {
    method: 'POST',
    body: JSON.stringify({ conversationId, message: 'hi', inputMode: 'telepathy' }),
  });
  check('an unknown input mode is rejected', injectedMode.status === 400, String(injectedMode.status));

  // =========================================== PAYMENT SAFETY (spec §69)
  section('Voice does not weaken payment safety');

  const email = `voice-${Date.now()}@shopiq.test`;
  const password = `Pw!${randomUUID().slice(0, 12)}`;
  const { data: user, error: userError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userError) throw new Error(userError.message);
  state.userId = user.user.id;
  await admin.from('customers').upsert({ id: state.userId, email, full_name: 'Voice Tester' });

  const buyer = session();
  await buyer.signIn(email, password);

  // A spoken "yes" with nothing on the table must do nothing at all.
  const strayYes = await buyer.http('/api/ai/chat', {
    method: 'POST',
    body: JSON.stringify({ message: 'haan bilkul, yes', inputMode: 'voice' }),
  });
  state.conversationIds.push(strayYes.payload?.conversationId);

  const { count: paymentsAfterStrayYes } = await admin
    .from('payments')
    .select('*', { count: 'exact', head: true })
    .eq('customer_id', state.userId);
  check('a stray spoken "yes" creates no payment', paymentsAfterStrayYes === 0, String(paymentsAfterStrayYes));

  const { count: confirmationsAfterStrayYes } = await admin
    .from('purchase_confirmations')
    .select('*', { count: 'exact', head: true })
    .eq('customer_id', state.userId);
  check('and no confirmation', confirmationsAfterStrayYes === 0, String(confirmationsAfterStrayYes));

  // Voice cannot name an amount either — the chat schema has no such field.
  const amountByVoice = await buyer.http('/api/ai/chat', {
    method: 'POST',
    body: JSON.stringify({ message: 'pay 1 rupee', inputMode: 'voice', amount: 100 }),
  });
  check('a voice turn cannot smuggle an amount', amountByVoice.status === 400, String(amountByVoice.status));

  // The payment endpoint itself is unmoved by voice.
  const payByVoice = await buyer.http('/api/payments/create', {
    method: 'POST',
    body: JSON.stringify({ conversationId: strayYes.payload?.conversationId }),
  });
  check('payment is still refused with no confirmation', payByVoice.status === 409, String(payByVoice.status));
  check(
    // Which check fires depends on how far the request gets: with no cart yet
    // the gate refuses at condition 2 before it ever reaches the confirmation
    // at 13. Both are correct refusals, so the assertion is that it refused
    // for an authorization reason — not which one won the race.
    'for an authorization reason, not a provider one',
    ['NO_CONFIRMATION', 'CART_NOT_FOUND', 'CART_EMPTY'].includes(
      payByVoice.payload?.error?.details?.reason,
    ),
    JSON.stringify(payByVoice.payload?.error?.details?.reason),
  );

  // Now the real flow, driven entirely by voice-mode messages.
  const { data: product } = await admin
    .from('products')
    .select('id, name')
    .eq('is_active', true)
    .gt('price', 1500)
    .lt('price', 9000)
    .limit(1)
    .single();
  await admin.from('inventory').update({ quantity: 50, reserved_quantity: 0 }).eq('product_id', product.id);
  await buyer.http('/api/cart/items', {
    method: 'POST',
    body: JSON.stringify({ productId: product.id, quantity: 1 }),
  });

  const readyToBuy = await buyer.http('/api/ai/chat', {
    method: 'POST',
    body: JSON.stringify({
      conversationId: strayYes.payload?.conversationId,
      message: 'I am ready to buy',
      inputMode: 'voice',
    }),
  });
  check(
    'a spoken purchase request quotes an exact total',
    readyToBuy.payload?.outcome === 'awaiting_purchase_confirmation',
    readyToBuy.payload?.outcome,
  );
  check('with a purchase payload', Boolean(readyToBuy.payload?.purchase?.confirmationId));
  check(
    'and a purchase_confirmation response type',
    readyToBuy.payload?.type === 'purchase_confirmation',
    readyToBuy.payload?.type,
  );
  check(
    'the spoken summary states the total',
    (readyToBuy.payload?.speech ?? '').includes('₹'),
    readyToBuy.payload?.speech?.slice(0, 90),
  );

  const { count: paymentsAtQuote } = await admin
    .from('payments')
    .select('*', { count: 'exact', head: true })
    .eq('customer_id', state.userId);
  check('quoting a total charges nothing', paymentsAtQuote === 0, String(paymentsAtQuote));

  // Change the cart AFTER the quote, then say yes by voice. Phase 4 must
  // refuse, exactly as it does for a click.
  await buyer.http('/api/cart/items', {
    method: 'POST',
    body: JSON.stringify({ productId: product.id, quantity: 1 }),
  });

  const yesAfterChange = await buyer.http('/api/ai/chat', {
    method: 'POST',
    body: JSON.stringify({
      conversationId: strayYes.payload?.conversationId,
      message: 'haan, proceed karo',
      inputMode: 'voice',
    }),
  });
  check(
    'a spoken yes after a cart change is blocked',
    yesAfterChange.payload?.outcome === 'payment_blocked',
    yesAfterChange.payload?.outcome,
  );
  check(
    'and no provider order was created',
    (
      await admin
        .from('payments')
        .select('*', { count: 'exact', head: true })
        .eq('customer_id', state.userId)
    ).count === 0,
  );

  // ============================================================= metrics
  section('Observability');

  const { data: voiceLogs } = await admin
    .from('ai_tool_logs')
    .select('tool_name, execution_time_ms, input')
    .in('tool_name', ['stt_started', 'stt_completed', 'stt_failed', 'tts_started', 'tts_completed', 'tts_failed'])
    .order('created_at', { ascending: false })
    .limit(50);

  const events = new Set((voiceLogs ?? []).map((row) => row.tool_name));
  check('TTS events are recorded', events.has('tts_started') && events.has('tts_completed'), [...events].join(','));
  check('STT events are recorded', events.has('stt_started') || events.has('stt_failed'), [...events].join(','));
  check(
    'latency is captured',
    (voiceLogs ?? []).some((row) => typeof row.execution_time_ms === 'number' && row.execution_time_ms >= 0),
  );
  check(
    'no audio is stored in the log',
    !JSON.stringify(voiceLogs).match(/RIFF|base64|audio_data|"audio"\s*:\s*"/),
  );
  check(
    'no credential is stored in the log',
    !JSON.stringify(voiceLogs).match(/subscription|api[_-]?key|secret/i),
  );

  console.log(`\n${'='.repeat(56)}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  · ${f}`);
  }
} finally {
  console.log('\nCleaning up…');
  await cleanup();
}

process.exit(failed > 0 ? 1 : 0);
