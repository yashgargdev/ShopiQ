import 'server-only';
import {
  VoiceProviderError,
  type SynthesisResult,
  type Transcript,
  type VoiceProvider,
} from './provider';

/**
 * A deterministic voice provider, used when no Sarvam key is configured.
 *
 * Same reasoning as the AI and payment mocks: the interesting logic in this
 * phase is the plumbing around speech — validation, session state, rate
 * limiting, interruption, the shared conversation, and the payment gate
 * refusing to soften for voice — and none of it should be untestable because a
 * third-party key is missing.
 *
 * It does not recognise speech. `transcribe()` returns a fixed phrase, which
 * is enough to prove the pipeline end to end without pretending to be an ASR.
 */

const MOCK_TRANSCRIPT = 'mujhe ek laptop chahiye';

/** A short, valid, silent WAV so playback code has something real to handle. */
function silentWav(milliseconds = 400, sampleRate = 22050): Buffer {
  const samples = Math.round((sampleRate * milliseconds) / 1000);
  const dataBytes = samples * 2; // 16-bit mono
  const buffer = Buffer.alloc(44 + dataBytes);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // PCM chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  // The sample region stays zeroed: silence, but structurally a real WAV.
  return buffer;
}

export const mockVoiceProvider: VoiceProvider = {
  name: 'mock',

  isLive() {
    return false;
  },

  async transcribe(audio): Promise<Transcript> {
    if (!audio || audio.byteLength === 0) {
      throw new VoiceProviderError('STT_FAILED', 'No audio supplied.', 400);
    }
    return {
      text: MOCK_TRANSCRIPT,
      language: 'hi-IN',
      languageConfidence: 0.5,
      durationMs: 1,
    };
  },

  async synthesize(text): Promise<SynthesisResult> {
    if (!text.trim()) {
      throw new VoiceProviderError('TTS_EMPTY', 'Nothing to say.', 400);
    }
    // Roughly proportional to the text, so timing-dependent UI behaves sanely.
    const milliseconds = Math.min(6000, 250 + text.length * 12);
    return {
      audio: silentWav(milliseconds),
      contentType: 'audio/wav',
      durationMs: 1,
    };
  },
};

/** Exported for tests that need to assert on the fixed transcript. */
export const MOCK_VOICE_TRANSCRIPT = MOCK_TRANSCRIPT;
