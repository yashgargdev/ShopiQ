/**
 * Phase 5 unit tests — no network, no database, no Sarvam account.
 *
 *   node scripts/test-voice-unit.mjs
 *
 * Covers the pure parts of the voice layer: audio validation by magic bytes,
 * WAV duration parsing, the derived response type, and the spoken-summary
 * trimming that keeps ShopiQ from reading a product grid aloud.
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./ts-loader.mjs', pathToFileURL(`${import.meta.dirname}/`));

const {
  detectAudioFormat,
  validateAudio,
  wavDurationMs,
  AudioValidationError,
  MAX_AUDIO_BYTES,
  MIN_AUDIO_BYTES,
} = await import('@/lib/voice/audio');
const { responseTypeFor, speakableSummary, shouldSpeak } = await import('@/lib/ai/response-type');

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
const threw = (fn) => {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
};

/** Build a valid PCM WAV of a given duration. */
function wav(milliseconds = 500, sampleRate = 16000) {
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
  return buffer;
}

// ======================================================== format detection
section('Audio format detection');

check('WAV is recognised', detectAudioFormat(wav()) === 'wav');

const ogg = Buffer.alloc(64);
ogg.write('OggS', 0, 'ascii');
check('OGG is recognised', detectAudioFormat(ogg) === 'ogg');

const webm = Buffer.alloc(64);
webm.set([0x1a, 0x45, 0xdf, 0xa3], 0);
check('WebM is recognised', detectAudioFormat(webm) === 'webm');

const flac = Buffer.alloc(64);
flac.write('fLaC', 0, 'ascii');
check('FLAC is recognised', detectAudioFormat(flac) === 'flac');

const mp4 = Buffer.alloc(64);
mp4.write('ftyp', 4, 'ascii');
check('MP4/M4A is recognised', detectAudioFormat(mp4) === 'mp4');

const id3 = Buffer.alloc(64);
id3.write('ID3', 0, 'ascii');
check('MP3 with an ID3 tag is recognised', detectAudioFormat(id3) === 'mp3');

const rawMp3 = Buffer.alloc(64);
rawMp3[0] = 0xff;
rawMp3[1] = 0xfb;
check('a raw MPEG frame is recognised', detectAudioFormat(rawMp3) === 'mp3');

// The point of magic bytes: a lie about the extension changes nothing.
const notAudio = Buffer.from('<?php system($_GET[0]); ?>'.padEnd(64, ' '), 'utf8');
check('a PHP file called .wav is NOT audio', detectAudioFormat(notAudio) === null);

const html = Buffer.from('<!doctype html><html><body>hi</body></html>'.padEnd(64), 'utf8');
check('HTML is NOT audio', detectAudioFormat(html) === null);
check('a truncated header is NOT audio', detectAudioFormat(Buffer.alloc(4)) === null);

// A RIFF container that is not WAVE (e.g. AVI) must not pass as audio.
const riffAvi = Buffer.alloc(64);
riffAvi.write('RIFF', 0, 'ascii');
riffAvi.write('AVI ', 8, 'ascii');
check('RIFF that is not WAVE is rejected', detectAudioFormat(riffAvi) === null);

// ============================================================== validation
section('Audio validation');

const good = validateAudio(wav(1000));
check('a valid WAV passes', good.format === 'wav' && good.mimeType === 'audio/wav');
check('the byte length is reported', good.byteLength > MIN_AUDIO_BYTES);

const tiny = threw(() => validateAudio(Buffer.alloc(64)));
check('a tiny file is refused', tiny instanceof AudioValidationError && tiny.code === 'AUDIO_TOO_SHORT', tiny?.code);

const huge = threw(() => validateAudio(Buffer.alloc(MAX_AUDIO_BYTES + 1)));
check('an oversized file is refused', huge instanceof AudioValidationError && huge.code === 'AUDIO_TOO_LARGE', huge?.code);

const junk = threw(() => validateAudio(Buffer.alloc(4096)));
check('unrecognised bytes are refused', junk instanceof AudioValidationError && junk.code === 'AUDIO_UNSUPPORTED', junk?.code);

// Size is checked before format, so an enormous file is never inspected.
const hugeAndInvalid = threw(() => validateAudio(Buffer.alloc(MAX_AUDIO_BYTES + 10)));
check('size is checked before format', hugeAndInvalid?.code === 'AUDIO_TOO_LARGE', hugeAndInvalid?.code);

// ============================================================== durations
section('WAV duration');

check('1s is measured', Math.abs(wavDurationMs(wav(1000)) - 1000) <= 2, String(wavDurationMs(wav(1000))));
check('250ms is measured', Math.abs(wavDurationMs(wav(250)) - 250) <= 2, String(wavDurationMs(wav(250))));
check('30s is measured', Math.abs(wavDurationMs(wav(30_000)) - 30_000) <= 5);
check('a non-WAV returns null', wavDurationMs(ogg) === null);
check('a truncated buffer returns null', wavDurationMs(Buffer.alloc(10)) === null);

// ========================================================== response type
section('Structured response type');

const base = {
  message: 'ok',
  products: [],
  comparison: null,
  actions: [],
  intent: 'recommend',
  outcome: 'matches',
  requirements: {},
  toolsUsed: [],
  provider: 'x',
  degraded: false,
  cart: null,
  checkout: null,
  pendingAction: null,
};

check('a bare reply is text', responseTypeFor({ ...base, outcome: 'answer' }) === 'text');
check(
  'products become product_recommendations',
  responseTypeFor({ ...base, products: [{ productId: 'a' }, { productId: 'b' }] }) ===
    'product_recommendations',
);
check(
  'one product on a product question is product_detail',
  responseTypeFor({ ...base, products: [{ productId: 'a' }], intent: 'product_question' }) ===
    'product_detail',
);
check('a comparison payload wins', responseTypeFor({ ...base, comparison: { rows: [] } }) === 'comparison');
check('a cart payload wins over products', responseTypeFor({ ...base, products: [{}], cart: { items: [] } }) === 'cart');
check('checkout beats cart', responseTypeFor({ ...base, cart: {}, checkout: {} }) === 'checkout');
check(
  'a purchase quote beats checkout',
  responseTypeFor({ ...base, cart: {}, checkout: {}, purchase: { confirmationId: 'x' } }) ===
    'purchase_confirmation',
);
check(
  'a payment beats a purchase quote',
  responseTypeFor({ ...base, purchase: {}, payment: { paymentId: 'p' } }) === 'payment',
);
check('an order beats everything', responseTypeFor({ ...base, payment: {}, order: { id: 'o' } }) === 'order');
check('an error outcome is error', responseTypeFor({ ...base, outcome: 'error' }) === 'error');

// ========================================================= spoken summary
section('Spoken summary');

const short = 'I found three good options.';
check('a short line is spoken verbatim', speakableSummary({ ...base, message: short }) === short);

const long =
  'I found six laptops in your budget. The ASUS TUF Gaming A15 is my top pick because it has 32 GB of RAM and an RTX 4060. ' +
  'The Lenovo Legion is a close second with similar performance and a slightly better display. ' +
  'The HP Victus is the lightest of the three and the cheapest by a small margin, though its GPU is a step down. ' +
  'The MSI Katana and the Acer Nitro round out the list, both with RTX 4050 graphics and 16 GB of memory.';
const spoken = speakableSummary({ ...base, message: long });
check('a long line is trimmed', spoken.length < long.length, `${spoken.length} of ${long.length}`);
check('trimming lands on a sentence boundary', /[.!?…]$/.test(spoken), spoken.slice(-40));
check('the first sentence survives', spoken.startsWith('I found six laptops'), spoken.slice(0, 40));

const hindi = 'Maine chhah laptops dhoonde hain. ASUS TUF sabse accha hai. '.repeat(12);
const hindiSpoken = speakableSummary({ ...base, message: hindi });
check('Hinglish is trimmed too', hindiSpoken.length <= 330, String(hindiSpoken.length));

check('an empty message is not spoken', shouldSpeak({ ...base, message: '   ' }) === false);
check('a real message is spoken', shouldSpeak({ ...base, message: 'Added to your cart.' }) === true);
check('an empty summary is empty', speakableSummary({ ...base, message: '' }) === '');

console.log(`\n${'='.repeat(56)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  · ${f}`);
}
process.exit(failed > 0 ? 1 : 0);
