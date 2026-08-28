import { NextResponse, type NextRequest } from 'next/server';
import { jsonOk, jsonError, withErrorHandling, ApiError } from '@/lib/api/response';
import { checkRateLimit } from '@/lib/ai/rate-limit';
import { openConversation } from '@/lib/ai/conversation/store';
import {
  voiceProvider,
  voiceStatus,
  validateAudio,
  wavDurationMs,
  AudioValidationError,
  MAX_AUDIO_BYTES,
  MAX_RECORDING_MS,
  VoiceProviderError,
} from '@/lib/voice';
import { recordVoiceMetric } from '@/lib/voice/metrics';
import { recordAiUsage } from '@/lib/analytics/track';

/**
 * POST /api/voice/transcribe
 *
 * Audio in, text out. That text then goes to `/api/ai/chat` exactly as if it
 * had been typed — this endpoint deliberately does not call the agent itself,
 * because a voice endpoint that also does the shopping is the beginning of a
 * second agent.
 *
 * The audio is held in memory for the length of one request and dropped. It is
 * never written to disk, never stored in the database, and never sent anywhere
 * except the speech provider.
 */

/** Voice is more expensive than text, so it gets its own tighter budget. */
const VOICE_LIMITS = {
  perSession: { limit: 12, windowMs: 60_000 },
  perIp: { limit: 25, windowMs: 60_000 },
} as const;

/**
 * Serverless execution limits.
 *
 * Transcription waits on Sarvam, which is slow for a long utterance. A platform's default timeout is
 * shorter than that, and a cut-off mid-call surfaces to the shopper as a dead
 * microphone rather than as an error anyone can act on.
 */
export const runtime = 'nodejs';
export const maxDuration = 60;

export const POST = withErrorHandling(async (request: NextRequest) => {
  const status = voiceStatus();

  // Size guard before reading the body: an oversized upload is refused
  // without ever being buffered.
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > MAX_AUDIO_BYTES + 4096) {
    throw new ApiError('PAYLOAD_TOO_LARGE', 'That recording is too large.');
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new ApiError('BAD_REQUEST', 'Expected multipart form data.');
  }

  const file = form.get('audio');
  if (!(file instanceof Blob)) {
    throw new ApiError('BAD_REQUEST', 'No audio was supplied.');
  }

  const conversationIdRaw = form.get('conversationId');
  const requestedLanguage = form.get('language');

  // Conversation ownership is enforced by openConversation(), which returns a
  // fresh conversation rather than someone else's if the id is not the
  // caller's — the same rule the chat route follows.
  const conversation = await openConversation(
    typeof conversationIdRaw === 'string' && conversationIdRaw ? conversationIdRaw : null,
  );

  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    'unknown';

  for (const [key, rule] of [
    [`voice:conv:${conversation.id}`, VOICE_LIMITS.perSession],
    [`voice:ip:${ip}`, VOICE_LIMITS.perIp],
  ] as const) {
    const verdict = checkRateLimit(key, rule);
    if (!verdict.allowed) {
      const retryAfter = verdict.retryAfter;
      return NextResponse.json(
        {
          error: {
            code: 'RATE_LIMITED',
            message: `You're sending voice faster than ShopiQ can listen. Try again in ${retryAfter} ${retryAfter === 1 ? 'second' : 'seconds'}.`,
          },
        },
        { status: 429, headers: { 'Retry-After': String(retryAfter) } },
      );
    }
  }

  let audio;
  try {
    audio = validateAudio(await file.arrayBuffer());
  } catch (error) {
    if (error instanceof AudioValidationError) {
      await recordVoiceMetric({
        event: 'stt_failed',
        conversationId: conversation.id,
        status: 'error',
        errorCode: error.code,
        provider: status.provider,
      });
      return jsonError('BAD_REQUEST', error.message, { reason: error.code });
    }
    throw error;
  }

  // A WAV long enough to be a monologue is refused before it costs anything.
  const durationMs = wavDurationMs(audio.bytes);
  if (durationMs !== null && durationMs > MAX_RECORDING_MS) {
    await recordVoiceMetric({
      event: 'stt_failed',
      conversationId: conversation.id,
      status: 'error',
      errorCode: 'AUDIO_TOO_LONG',
      audioBytes: audio.byteLength,
      audioFormat: audio.format,
    });
    return jsonError(
      'BAD_REQUEST',
      "That was a little long. Let's continue with a shorter message.",
      { reason: 'AUDIO_TOO_LONG' },
    );
  }

  await recordVoiceMetric({
    event: 'stt_started',
    conversationId: conversation.id,
    provider: status.provider,
    audioBytes: audio.byteLength,
    audioFormat: audio.format,
  });

  const provider = voiceProvider();

  try {
    const transcript = await provider.transcribe(audio.bytes, {
      language:
        typeof requestedLanguage === 'string' && requestedLanguage ? (requestedLanguage as any) : 'auto',
      mimeType: audio.mimeType,
    });

    await recordAiUsage({
      conversationId: conversation.id,
      kind: 'stt',
      provider: provider.name,
      latencyMs: transcript.durationMs,
      audioSeconds: durationMs === null ? null : Math.round((durationMs / 1000) * 100) / 100,
    });
    await recordVoiceMetric({
      event: 'stt_completed',
      conversationId: conversation.id,
      provider: provider.name,
      language: transcript.language,
      latencyMs: transcript.durationMs,
      audioBytes: audio.byteLength,
      audioFormat: audio.format,
      inputMode: 'voice',
    });

    if (!transcript.text) {
      return jsonError('BAD_REQUEST', "I couldn't understand that. Please try again.", {
        reason: 'EMPTY_TRANSCRIPT',
      });
    }

    return jsonOk(
      {
        conversationId: conversation.id,
        transcript: {
          text: transcript.text,
          language: transcript.language,
          language_confidence: transcript.languageConfidence,
        },
        latency: { stt_ms: transcript.durationMs },
        provider: provider.name,
        /** Stated so the client never has to infer it: the audio is gone. */
        audio_retained: false,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    const voiceError = error instanceof VoiceProviderError ? error : null;
    await recordVoiceMetric({
      event: 'stt_failed',
      conversationId: conversation.id,
      provider: provider.name,
      status: 'error',
      errorCode: voiceError?.code ?? 'STT_FAILED',
      audioBytes: audio.byteLength,
      audioFormat: audio.format,
    });

    if (voiceError?.status === 429) {
      return NextResponse.json(
        { error: { code: 'RATE_LIMITED', message: 'The speech service is busy. Try again shortly.' } },
        { status: 429, headers: { 'Retry-After': '5' } },
      );
    }

    // The customer gets the fallback, not the provider's error text.
    return jsonError('INTERNAL_ERROR', "I couldn't understand that. Please try again.", {
      reason: voiceError?.code ?? 'STT_FAILED',
      can_type_instead: true,
    });
  }
});
