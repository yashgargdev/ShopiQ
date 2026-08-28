/**
 * The voice provider contract.
 *
 * Voice is an INTERFACE, not a second brain. Speech-to-text produces the same
 * string the text box produces, and text-to-speech reads back the same string
 * the panel already displayed. Nothing downstream — extraction, tools,
 * scoring, cart, confirmation, payment — knows or cares which one was used.
 *
 * Nothing outside `lib/voice/` knows that Sarvam exists, exactly as nothing
 * outside `lib/payments/` knows about Razorpay.
 */

export type VoiceProviderName = 'sarvam' | 'mock';

/** BCP-47-ish codes Sarvam accepts, plus the auto-detect sentinel. */
export type VoiceLanguage =
  | 'auto'
  | 'en-IN'
  | 'hi-IN'
  | 'bn-IN'
  | 'gu-IN'
  | 'kn-IN'
  | 'ml-IN'
  | 'mr-IN'
  | 'od-IN'
  | 'pa-IN'
  | 'ta-IN'
  | 'te-IN';

export interface Transcript {
  /** What the customer said, as ordinary text. */
  text: string;
  /** Detected language, when the provider reports one. */
  language: string | null;
  /** Provider confidence in the language call, 0–1. */
  languageConfidence: number | null;
  /** Round-trip time to the provider, for the latency budget. */
  durationMs: number;
}

export interface SynthesisResult {
  /** Raw audio bytes. Never persisted — streamed to the caller and dropped. */
  audio: Buffer;
  contentType: string;
  durationMs: number;
}

export interface SynthesisOptions {
  /** Target language. Defaults to the conversation's working language. */
  language?: VoiceLanguage;
  /** Provider voice name. */
  speaker?: string;
  /** 0.5–2.0. Slower is easier to follow when reading out a price. */
  pace?: number;
}

export interface VoiceProvider {
  readonly name: VoiceProviderName;

  /** True when real credentials are configured. */
  isLive(): boolean;

  transcribe(audio: Buffer, options?: { language?: VoiceLanguage; mimeType?: string }): Promise<Transcript>;

  synthesize(text: string, options?: SynthesisOptions): Promise<SynthesisResult>;
}

export class VoiceProviderError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 502) {
    super(message);
    this.name = 'VoiceProviderError';
    this.code = code;
    this.status = status;
  }
}
