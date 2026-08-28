import 'server-only';
import {
  VoiceProviderError,
  type SynthesisResult,
  type Transcript,
  type VoiceLanguage,
  type VoiceProvider,
} from './provider';

/**
 * Sarvam AI — speech-to-text and text-to-speech.
 *
 * Sarvam's speech endpoints live at the API root, not under the `/v1` path the
 * Phase 2 chat provider uses, and they authenticate with `api-subscription-key`
 * rather than a bearer token. Both quirks are contained here.
 *
 * The key is read in this file and nowhere else. It imports `server-only`, so
 * an accidental client import fails the build rather than shipping the key.
 */

const SPEECH_BASE = process.env.SARVAM_SPEECH_BASE_URL ?? 'https://api.sarvam.ai';

/**
 * Sarvam deprecates speech models aggressively and the API returns a hard 400
 * when you use a retired one — `saarika:v2` went first, then `bulbul:v2` during
 * this project. Both defaults are therefore pinned to models verified working
 * against the live API, and are overridable by environment variable so a future
 * deprecation is a config change rather than a deploy.
 *
 * The speaker list is model-specific: `bulbul:v3` rejects `anushka`, which was
 * valid on v2. `ritu` is from the v3 roster.
 */
/**
 * `saaras:v3` on the TRANSCRIBE endpoint returns the customer's own language —
 * "मुझे पचास हज़ार के अंदर एक लैपटॉप चाहिए". The SAME model on
 * `/speech-to-text-translate` returns English instead, which would quietly
 * destroy Hinglish before the agent ever saw it. The endpoint decides this, not
 * the model, so it is pinned in transcribe() and must stay pinned.
 */
const DEFAULT_STT_MODEL = process.env.SARVAM_STT_MODEL ?? 'saaras:v3';
const DEFAULT_TTS_MODEL = process.env.SARVAM_TTS_MODEL ?? 'bulbul:v3';
const DEFAULT_SPEAKER = process.env.SARVAM_TTS_SPEAKER ?? 'ritu';

/**
 * Voices bulbul:v3 accepts, each verified against the live API.
 *
 * The gender labels are inferred from the names — Sarvam publishes no gender
 * field — so they are a UI convenience, not a claim from the provider.
 */
export const VOICE_OPTIONS = [
  { id: 'ritu', label: 'Ritu', gender: 'female' as const },
  { id: 'priya', label: 'Priya', gender: 'female' as const },
  { id: 'neha', label: 'Neha', gender: 'female' as const },
  { id: 'kavya', label: 'Kavya', gender: 'female' as const },
  { id: 'aditya', label: 'Aditya', gender: 'male' as const },
  { id: 'rohan', label: 'Rohan', gender: 'male' as const },
];

const VALID_SPEAKERS = new Set(VOICE_OPTIONS.map((voice) => voice.id));

/** Sarvam rejects an over-long single TTS request; this is well inside it. */
const MAX_TTS_CHARS = 1500;

function apiKey(): string | null {
  return process.env.SARVAM_API_KEY?.trim() || null;
}

function requireKey(): string {
  const key = apiKey();
  if (!key) {
    throw new VoiceProviderError('VOICE_NOT_CONFIGURED', 'Sarvam is not configured.', 503);
  }
  return key;
}

/**
 * Sarvam wants a concrete language code for TTS. `auto` is only meaningful on
 * the way in, so it collapses to Indian English on the way out — the language
 * the assistant's own copy is written in.
 */
function ttsLanguage(language: VoiceLanguage | undefined): string {
  if (!language || language === 'auto') return 'en-IN';
  return language;
}

export const sarvamVoiceProvider: VoiceProvider = {
  name: 'sarvam',

  isLive() {
    return Boolean(apiKey());
  },

  async transcribe(audio, options): Promise<Transcript> {
    const key = requireKey();
    const startedAt = Date.now();

    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(audio)], { type: options?.mimeType ?? 'audio/wav' }),
      'speech.wav',
    );
    form.append('model', DEFAULT_STT_MODEL);
    // Omitting language_code lets Sarvam detect it, which is what makes
    // Hinglish and mid-conversation language switching work without asking
    // the customer to declare anything.
    if (options?.language && options.language !== 'auto') {
      form.append('language_code', options.language);
    }

    let response: Response;
    try {
      response = await fetch(`${SPEECH_BASE}/speech-to-text`, {
        method: 'POST',
        headers: { 'api-subscription-key': key },
        body: form,
      });
    } catch {
      throw new VoiceProviderError('VOICE_UNREACHABLE', 'Could not reach the speech service.', 502);
    }

    const text = await response.text();
    if (!response.ok) {
      let detail = `Speech service returned ${response.status}.`;
      try {
        const body = JSON.parse(text);
        detail = String(body?.detail ?? body?.error?.message ?? detail);
      } catch {
        /* keep the generic message */
      }
      throw new VoiceProviderError(
        response.status === 429 ? 'VOICE_RATE_LIMITED' : 'STT_FAILED',
        detail.slice(0, 300),
        response.status === 429 ? 429 : 502,
      );
    }

    const body = JSON.parse(text);
    return {
      text: String(body?.transcript ?? '').trim(),
      language: body?.language_code ? String(body.language_code) : null,
      languageConfidence:
        typeof body?.language_probability === 'number' ? body.language_probability : null,
      durationMs: Date.now() - startedAt,
    };
  },

  async synthesize(text, options): Promise<SynthesisResult> {
    const key = requireKey();
    const startedAt = Date.now();

    const trimmed = text.trim().slice(0, MAX_TTS_CHARS);
    if (!trimmed) {
      throw new VoiceProviderError('TTS_EMPTY', 'Nothing to say.', 400);
    }

    let response: Response;
    try {
      response = await fetch(`${SPEECH_BASE}/text-to-speech`, {
        method: 'POST',
        headers: { 'api-subscription-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: trimmed,
          target_language_code: ttsLanguage(options?.language),
          model: DEFAULT_TTS_MODEL,
          // An unknown speaker is a hard 400 from Sarvam, so an unrecognised
          // choice falls back rather than failing the whole reply.
          speaker:
            options?.speaker && VALID_SPEAKERS.has(options.speaker)
              ? options.speaker
              : DEFAULT_SPEAKER,
          ...(options?.pace ? { pace: options.pace } : {}),
        }),
      });
    } catch {
      throw new VoiceProviderError('VOICE_UNREACHABLE', 'Could not reach the speech service.', 502);
    }

    const raw = await response.text();
    if (!response.ok) {
      let detail = `Speech service returned ${response.status}.`;
      try {
        const body = JSON.parse(raw);
        detail = String(body?.detail ?? body?.error?.message ?? detail);
      } catch {
        /* keep the generic message */
      }
      throw new VoiceProviderError(
        response.status === 429 ? 'VOICE_RATE_LIMITED' : 'TTS_FAILED',
        detail.slice(0, 300),
        response.status === 429 ? 429 : 502,
      );
    }

    const body = JSON.parse(raw);
    const encoded = Array.isArray(body?.audios) ? body.audios[0] : null;
    if (!encoded) {
      throw new VoiceProviderError('TTS_FAILED', 'The speech service returned no audio.', 502);
    }

    return {
      audio: Buffer.from(String(encoded), 'base64'),
      contentType: 'audio/wav',
      durationMs: Date.now() - startedAt,
    };
  },
};
