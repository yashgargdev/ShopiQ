import 'server-only';
import { mockVoiceProvider } from './mock';
import { sarvamVoiceProvider } from './sarvam';
import type { VoiceProvider } from './provider';

export * from './provider';
export * from './audio';
export { VOICE_OPTIONS } from './sarvam';

/**
 * Select the voice provider.
 *
 * Sarvam whenever its key is present, otherwise the deterministic mock. Unlike
 * the payment mock, this one is harmless in production — the worst case is
 * that voice does not work and the customer types instead, which is the
 * documented fallback anyway. So there is no hard refusal here; the status
 * endpoint simply reports that voice is not live.
 */
export function voiceProvider(): VoiceProvider {
  return sarvamVoiceProvider.isLive() ? sarvamVoiceProvider : mockVoiceProvider;
}

/** What the UI needs to decide whether to offer a microphone. Never a key. */
export function voiceStatus(): {
  provider: 'sarvam' | 'mock';
  live: boolean;
  sttModel: string;
  ttsModel: string;
} {
  const live = sarvamVoiceProvider.isLive();
  return {
    provider: live ? 'sarvam' : 'mock',
    live,
    // Model names are not secrets, and knowing them makes a bug report useful.
    sttModel: process.env.SARVAM_STT_MODEL ?? 'saarika:v2.5',
    ttsModel: process.env.SARVAM_TTS_MODEL ?? 'bulbul:v3',
  };
}
