import 'server-only';
import { adminClient } from '@/lib/supabase/admin';

/**
 * Voice observability.
 *
 * Events land in `ai_tool_logs`, the table Phase 2 already built for exactly
 * this — a server-side, RLS-with-no-policy audit surface no browser role can
 * read. Reusing it beats a second logging table that would need its own
 * privileges, its own retention and its own bugs.
 *
 * **Raw audio is never recorded here.** Only its size, format and duration —
 * enough to debug a failure, nothing that reconstructs what someone said.
 */

export type VoiceEvent =
  | 'voice_session_started'
  | 'voice_recording_started'
  | 'voice_recording_stopped'
  | 'stt_started'
  | 'stt_completed'
  | 'stt_failed'
  | 'ai_started'
  | 'ai_completed'
  | 'tts_started'
  | 'tts_completed'
  | 'tts_failed'
  | 'voice_interrupted';

export interface VoiceMetric {
  event: VoiceEvent;
  conversationId?: string | null;
  /** Milliseconds for the stage this event closes. */
  latencyMs?: number | null;
  provider?: string | null;
  language?: string | null;
  inputMode?: 'voice' | 'text' | null;
  status?: 'success' | 'error';
  errorCode?: string | null;
  /** Size and shape of the audio — never the audio. */
  audioBytes?: number | null;
  audioFormat?: string | null;
  /** Character count of synthesized text, for cost tracking. */
  textLength?: number | null;
}

/**
 * Record a voice event. Never throws: observability failing must not take down
 * a working conversation.
 */
export async function recordVoiceMetric(metric: VoiceMetric): Promise<void> {
  try {
    await adminClient()
      .from('ai_tool_logs')
      .insert({
        conversation_id: metric.conversationId ?? null,
        tool_name: metric.event,
        input: {
          provider: metric.provider ?? null,
          language: metric.language ?? null,
          input_mode: metric.inputMode ?? null,
          audio_bytes: metric.audioBytes ?? null,
          audio_format: metric.audioFormat ?? null,
          text_length: metric.textLength ?? null,
        },
        output: metric.errorCode ? { error_code: metric.errorCode } : {},
        status: metric.status === 'error' ? 'error' : 'success',
        error: metric.errorCode ?? null,
        execution_time_ms: metric.latencyMs ?? null,
      });
  } catch (error) {
    console.error(`[voice] could not record ${metric.event}`, error);
  }
}

/**
 * A stopwatch for one voice turn.
 *
 * The interesting number for a demo is not any single stage but the total from
 * the customer finishing speaking to hearing a reply, so the marks are kept
 * together and reported as a breakdown.
 */
export class VoiceTimer {
  private readonly startedAt = Date.now();
  private readonly marks = new Map<string, number>();
  private last = Date.now();

  /** Close a stage and return its own duration. */
  mark(stage: string): number {
    const now = Date.now();
    const elapsed = now - this.last;
    this.marks.set(stage, elapsed);
    this.last = now;
    return elapsed;
  }

  get totalMs(): number {
    return Date.now() - this.startedAt;
  }

  breakdown(): Record<string, number> {
    return { ...Object.fromEntries(this.marks), total: this.totalMs };
  }
}
