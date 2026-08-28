import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { withErrorHandling, ApiError } from '@/lib/api/response';
import { checkRateLimit } from '@/lib/ai/rate-limit';
import { voiceProvider, voiceStatus, VoiceProviderError } from '@/lib/voice';
import { recordVoiceMetric } from '@/lib/voice/metrics';
import { recordAiUsage } from '@/lib/analytics/track';

/**
 * POST /api/voice/synthesize
 *
 * Text in, audio out. Returns the audio bytes directly rather than a URL,
 * because there is no URL: nothing is stored. The response is generated,
 * streamed once and forgotten.
 *
 * TTS is a convenience layer. If it fails, the caller still has the text — so
 * every failure here is a soft one, and the client is told to show the text
 * rather than treat the turn as broken.
 */

/** Speech is billed per character, so this is deliberately tight. */
const TTS_LIMITS = {
  perSession: { limit: 20, windowMs: 60_000 },
  perIp: { limit: 40, windowMs: 60_000 },
} as const;

/**
 * Long enough for a recommendation or a checkout summary, short enough that
 * nobody reads a spec sheet aloud. Callers are expected to send a spoken
 * summary, not the whole card.
 */
const MAX_SPEAKABLE_CHARS = 600;

const bodySchema = z
  .object({
    text: z.string().trim().min(1).max(MAX_SPEAKABLE_CHARS),
    conversationId: z.string().uuid().nullish(),
    language: z.string().max(10).nullish(),
    speaker: z.string().max(40).nullish(),
  })
  .strict();

/**
 * Serverless execution limits.
 *
 * Synthesis waits on Sarvam and returns audio for a whole reply. A platform's default timeout is
 * shorter than that, and a cut-off mid-call surfaces to the shopper as a dead
 * microphone rather than as an error anyone can act on.
 */
export const runtime = 'nodejs';
export const maxDuration = 60;

export const POST = withErrorHandling(async (request: NextRequest) => {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ApiError('BAD_REQUEST', 'Expected a JSON body.');
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError('BAD_REQUEST', 'Invalid speech request.', parsed.error.flatten());
  }
  const { text, conversationId, language, speaker } = parsed.data;

  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    'unknown';

  for (const [key, rule] of [
    [`tts:conv:${conversationId ?? ip}`, TTS_LIMITS.perSession],
    [`tts:ip:${ip}`, TTS_LIMITS.perIp],
  ] as const) {
    const verdict = checkRateLimit(key, rule);
    if (!verdict.allowed) {
      const retryAfter = verdict.retryAfter;
      return NextResponse.json(
        { error: { code: 'RATE_LIMITED', message: 'Too much speech at once. Try again shortly.' } },
        { status: 429, headers: { 'Retry-After': String(retryAfter) } },
      );
    }
  }

  const provider = voiceProvider();
  const status = voiceStatus();

  await recordVoiceMetric({
    event: 'tts_started',
    conversationId: conversationId ?? null,
    provider: status.provider,
    textLength: text.length,
    language: language ?? null,
  });

  try {
    const result = await provider.synthesize(text, {
      language: (language as any) ?? 'auto',
      speaker: speaker ?? undefined,
    });

    await recordAiUsage({
      conversationId: conversationId ?? null,
      kind: 'tts',
      provider: provider.name,
      latencyMs: result.durationMs,
    });
    await recordVoiceMetric({
      event: 'tts_completed',
      conversationId: conversationId ?? null,
      provider: provider.name,
      latencyMs: result.durationMs,
      textLength: text.length,
      language: language ?? null,
    });

    // Audio bytes straight back. No file is written, so there is nothing to
    // clean up and nothing to leak.
    return new NextResponse(new Uint8Array(result.audio), {
      status: 200,
      headers: {
        'Content-Type': result.contentType,
        'Content-Length': String(result.audio.byteLength),
        'Cache-Control': 'no-store',
        'X-Voice-Provider': provider.name,
        'X-Voice-Latency-Ms': String(result.durationMs),
      },
    });
  } catch (error) {
    const voiceError = error instanceof VoiceProviderError ? error : null;
    await recordVoiceMetric({
      event: 'tts_failed',
      conversationId: conversationId ?? null,
      provider: provider.name,
      status: 'error',
      errorCode: voiceError?.code ?? 'TTS_FAILED',
      textLength: text.length,
    });

    // 503 rather than 500: the text response is fine, only the voice is not.
    // `text_still_valid` tells the client to keep the message on screen.
    return NextResponse.json(
      {
        error: {
          code: 'INTERNAL_ERROR',
          message: "Voice playback isn't available right now, but here's the response.",
          details: { reason: voiceError?.code ?? 'TTS_FAILED', text_still_valid: true },
        },
      },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
});
