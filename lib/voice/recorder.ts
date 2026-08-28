/**
 * Browser microphone capture.
 *
 * Records to **16-bit PCM WAV** rather than using MediaRecorder's WebM/Opus.
 * MediaRecorder is easier, but its output format varies by browser and speech
 * APIs are picky about containers; encoding WAV ourselves means one known
 * format everywhere, with no server-side transcoding and no ffmpeg dependency.
 *
 * Cleanup is the other half of the job. A microphone left open is a privacy
 * problem, not just a leak, so every path through this class ends with the
 * tracks stopped and the audio graph torn down.
 */

export const TARGET_SAMPLE_RATE = 16_000;
export const MAX_RECORDING_MS = 30_000;

export type RecorderUnavailableReason =
  | 'insecure_context'
  | 'unsupported_browser'
  | 'permission_denied'
  | 'no_microphone';

export class RecorderError extends Error {
  reason: RecorderUnavailableReason | 'capture_failed';
  constructor(reason: RecorderError['reason'], message: string) {
    super(message);
    this.name = 'RecorderError';
    this.reason = reason;
  }
}

/** Whether this browser can record at all, checked before offering a button. */
export function microphoneSupported(): { supported: boolean; reason?: RecorderUnavailableReason } {
  if (typeof window === 'undefined') return { supported: false, reason: 'unsupported_browser' };
  // getUserMedia is unavailable outside a secure context, which is a common
  // and very confusing cause of "the button does nothing" on LAN testing.
  if (!window.isSecureContext) return { supported: false, reason: 'insecure_context' };
  if (!navigator.mediaDevices?.getUserMedia) {
    return { supported: false, reason: 'unsupported_browser' };
  }
  const AudioCtx = window.AudioContext ?? (window as any).webkitAudioContext;
  if (!AudioCtx) return { supported: false, reason: 'unsupported_browser' };
  return { supported: true };
}

/** Downsample float PCM to the target rate with simple averaging. */
function downsample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (toRate >= fromRate) return input;
  const ratio = fromRate / toRate;
  const length = Math.floor(input.length / ratio);
  const output = new Float32Array(length);

  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), input.length);
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    output[i] = end > start ? sum / (end - start) : 0;
  }
  return output;
}

/** Float samples in [-1, 1] to a 16-bit PCM WAV blob. */
function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export interface RecordingResult {
  blob: Blob;
  durationMs: number;
  /** Peak amplitude, used to tell silence from speech before spending an API call. */
  peak: number;
}

export class VoiceRecorder {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private chunks: Float32Array[] = [];
  private startedAt = 0;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private recording = false;

  /** Live level 0–1, for the visualiser. */
  level = 0;

  get isRecording(): boolean {
    return this.recording;
  }

  async start(onLevel?: (level: number) => void): Promise<void> {
    // Guard against a double-click opening two capture sessions.
    if (this.recording) return;

    const support = microphoneSupported();
    if (!support.supported) {
      throw new RecorderError(
        support.reason ?? 'unsupported_browser',
        "I can't access your microphone. You can continue shopping using text.",
      );
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch (error: any) {
      const denied = error?.name === 'NotAllowedError' || error?.name === 'SecurityError';
      const missing = error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError';
      throw new RecorderError(
        denied ? 'permission_denied' : missing ? 'no_microphone' : 'capture_failed',
        denied
          ? 'Microphone access is blocked. Allow it in your browser, or keep shopping using text.'
          : "I can't access your microphone. You can continue shopping using text.",
      );
    }

    const AudioCtx = window.AudioContext ?? (window as any).webkitAudioContext;
    this.context = new AudioCtx();
    this.source = this.context.createMediaStreamSource(this.stream);

    // ScriptProcessor is deprecated but is the one path available in every
    // browser without shipping a worklet file; the buffer is small enough that
    // the main-thread cost is not noticeable for short utterances.
    this.processor = this.context.createScriptProcessor(4096, 1, 1);
    this.chunks = [];
    this.startedAt = Date.now();
    this.recording = true;

    this.processor.onaudioprocess = (event) => {
      if (!this.recording) return;
      const input = event.inputBuffer.getChannelData(0);
      this.chunks.push(new Float32Array(input));

      let peak = 0;
      for (let i = 0; i < input.length; i += 16) peak = Math.max(peak, Math.abs(input[i]));
      this.level = peak;
      onLevel?.(peak);
    };

    this.source.connect(this.processor);
    // Connecting to the destination keeps the processor pumping in some
    // browsers. Gain is zeroed so nothing is echoed back to the speakers.
    const mute = this.context.createGain();
    mute.gain.value = 0;
    this.processor.connect(mute);
    mute.connect(this.context.destination);

    // A hard ceiling, so a forgotten tab cannot record indefinitely.
    this.stopTimer = setTimeout(() => {
      if (this.recording) this.stop().catch(() => {});
    }, MAX_RECORDING_MS);
  }

  /** Stop, tear down, and return the encoded recording. */
  async stop(): Promise<RecordingResult | null> {
    if (!this.recording) {
      this.teardown();
      return null;
    }
    this.recording = false;
    const durationMs = Date.now() - this.startedAt;
    const sampleRate = this.context?.sampleRate ?? 44_100;

    this.teardown();

    const total = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (total === 0) return null;

    const merged = new Float32Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    this.chunks = [];

    let peak = 0;
    for (let i = 0; i < merged.length; i += 32) peak = Math.max(peak, Math.abs(merged[i]));

    const resampled = downsample(merged, sampleRate, TARGET_SAMPLE_RATE);
    return { blob: encodeWav(resampled, TARGET_SAMPLE_RATE), durationMs, peak };
  }

  /** Abandon a recording without producing audio. */
  cancel(): void {
    this.recording = false;
    this.chunks = [];
    this.teardown();
  }

  /**
   * Release everything. Safe to call more than once — this runs from unmount
   * and from navigation as well as from stop().
   */
  private teardown(): void {
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    if (this.processor) {
      this.processor.onaudioprocess = null;
      try {
        this.processor.disconnect();
      } catch {
        /* already disconnected */
      }
      this.processor = null;
    }
    if (this.source) {
      try {
        this.source.disconnect();
      } catch {
        /* already disconnected */
      }
      this.source = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.context && this.context.state !== 'closed') {
      void this.context.close().catch(() => {});
    }
    this.context = null;
    this.level = 0;
  }
}
