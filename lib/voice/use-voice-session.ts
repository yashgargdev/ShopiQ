'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { VoiceRecorder, RecorderError, microphoneSupported } from './recorder';

/**
 * The voice session.
 *
 * One state machine owns the microphone, the transcription request and the
 * playback element, because these three things fight if they are owned
 * separately: audio keeps playing after a new recording starts, two recordings
 * overlap on a double-click, a stale reply speaks over a fresh one.
 *
 * The states are exactly the ones the UI shows, so there is never a gap
 * between what is happening and what the customer is told.
 */

export type VoiceState =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'speaking'
  | 'interrupted'
  | 'error';

export const VOICE_STATE_LABEL: Record<VoiceState, string> = {
  idle: 'Talk to ShopiQ',
  listening: 'Listening…',
  transcribing: 'Understanding…',
  thinking: 'Finding the best options…',
  speaking: 'ShopiQ is speaking',
  interrupted: 'Stopped',
  error: 'Something went wrong. Try again.',
};

export interface VoiceLatency {
  sttMs?: number;
  aiMs?: number;
  ttsMs?: number;
  totalMs?: number;
}

export interface UseVoiceSession {
  state: VoiceState;
  level: number;
  error: string | null;
  supported: boolean;
  unsupportedReason: string | null;
  latency: VoiceLatency;
  /** Start listening, or stop and submit if already listening. */
  toggle: () => void;
  /** Stop everything: recording, playback, pending work. */
  cancel: () => void;
  /** Speak a line. Resolves when playback ends or is interrupted. */
  speak: (text: string, language?: string | null) => Promise<void>;
  /** Called while the agent is working, so the UI can show "thinking". */
  setThinking: (thinking: boolean) => void;
  clearError: () => void;
}

export interface VoiceSessionOptions {
  conversationId: string | null;
  /** Receives the transcript. The caller sends it to /api/ai/chat. */
  onTranscript: (text: string, meta: { language: string | null; sttMs: number }) => void;
  /** Whether replies should be spoken at all. */
  enabled?: boolean;
}

const UNSUPPORTED_COPY: Record<string, string> = {
  insecure_context:
    'Voice needs a secure connection. Open ShopiQ over https or on localhost — a LAN address over http cannot use the microphone. You can keep shopping using text.',
  unsupported_browser:
    "This browser doesn't support voice input. You can continue shopping using text.",
  permission_denied:
    'Microphone access is blocked. Allow it in your browser, or keep shopping using text.',
  no_microphone: "I can't find a microphone. You can continue shopping using text.",
};

export function useVoiceSession(options: VoiceSessionOptions): UseVoiceSession {
  const { conversationId, onTranscript, enabled = true } = options;

  const [state, setState] = useState<VoiceState>('idle');
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [latency, setLatency] = useState<VoiceLatency>({});

  const recorderRef = useRef<VoiceRecorder | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** Guards against overlapping submissions from a double-click. */
  const busyRef = useRef(false);

  const support = typeof window === 'undefined' ? { supported: false } : microphoneSupported();
  const unsupportedReason = support.supported
    ? null
    : (UNSUPPORTED_COPY[support.reason ?? 'unsupported_browser'] ?? null);

  /** Stop any playback immediately and release its object URL. */
  const stopPlayback = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.onended = null;
      audio.onerror = null;
      audio.src = '';
      audioRef.current = null;
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    recorderRef.current?.cancel();
    recorderRef.current = null;
    stopPlayback();
    busyRef.current = false;
    setLevel(0);
    setState('idle');
  }, [stopPlayback]);

  // Nothing may outlive the component: a microphone still open or audio still
  // playing after the panel closes is a bug the customer can hear.
  useEffect(() => cancel, [cancel]);

  const speak = useCallback(
    async (text: string, language?: string | null) => {
      if (!enabled || !text.trim()) return;

      // A new line always replaces the old one rather than queueing behind it.
      stopPlayback();

      const startedAt = Date.now();
      let response: Response;
      try {
        response = await fetch('/api/voice/synthesize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, conversationId, language: language ?? undefined }),
        });
      } catch {
        // TTS is a convenience. The text is already on screen, so a network
        // failure here is silent rather than an error state.
        return;
      }

      if (!response.ok) return;

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;

      const audio = new Audio(url);
      audioRef.current = audio;
      setLatency((current) => ({ ...current, ttsMs: Date.now() - startedAt }));
      setState('speaking');

      await new Promise<void>((resolve) => {
        audio.onended = () => {
          stopPlayback();
          // Only fall back to idle if nothing else has taken over since.
          setState((current) => (current === 'speaking' ? 'idle' : current));
          resolve();
        };
        audio.onerror = () => {
          stopPlayback();
          setState((current) => (current === 'speaking' ? 'idle' : current));
          resolve();
        };
        void audio.play().catch(() => {
          // Autoplay policies can refuse. The text is still there.
          stopPlayback();
          setState((current) => (current === 'speaking' ? 'idle' : current));
          resolve();
        });
      });
    },
    [conversationId, enabled, stopPlayback],
  );

  const submitRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (!recorder) return;

    const recording = await recorder.stop();
    setLevel(0);

    if (!recording || recording.peak < 0.01) {
      // Effectively silence — say so rather than paying for a transcription
      // that will come back empty.
      setState('error');
      setError("I didn't hear anything. Try again.");
      busyRef.current = false;
      return;
    }

    setState('transcribing');
    const startedAt = Date.now();

    const form = new FormData();
    form.append('audio', recording.blob, 'speech.wav');
    if (conversationId) form.append('conversationId', conversationId);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch('/api/voice/transcribe', {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok || !payload?.transcript?.text) {
        setState('error');
        setError(payload?.error?.message ?? "I couldn't understand that. Please try again.");
        busyRef.current = false;
        return;
      }

      const sttMs = payload.latency?.stt_ms ?? Date.now() - startedAt;
      setLatency({ sttMs });
      setState('thinking');
      onTranscript(payload.transcript.text, {
        language: payload.transcript.language ?? null,
        sttMs,
      });
    } catch (fetchError: any) {
      if (fetchError?.name === 'AbortError') {
        setState('idle');
      } else {
        setState('error');
        setError("I couldn't understand that. Please try again.");
      }
      busyRef.current = false;
    } finally {
      abortRef.current = null;
    }
  }, [conversationId, onTranscript]);

  const toggle = useCallback(() => {
    setError(null);

    // Pressing the button while ShopiQ is talking interrupts it and starts
    // listening — the customer never has to wait for a reply to finish.
    if (state === 'speaking') {
      stopPlayback();
      setState('interrupted');
    }

    if (state === 'listening') {
      void submitRecording();
      return;
    }

    if (busyRef.current) return; // a submission is already in flight
    if (!support.supported) {
      setState('error');
      setError(unsupportedReason);
      return;
    }

    busyRef.current = true;
    const recorder = new VoiceRecorder();
    recorderRef.current = recorder;

    recorder
      .start((peak) => setLevel(peak))
      .then(() => setState('listening'))
      .catch((startError: unknown) => {
        recorderRef.current = null;
        busyRef.current = false;
        setState('error');
        setError(
          startError instanceof RecorderError
            ? startError.message
            : "I can't access your microphone. You can continue shopping using text.",
        );
      });
  }, [state, stopPlayback, submitRecording, support.supported, unsupportedReason]);

  const setThinking = useCallback((thinking: boolean) => {
    busyRef.current = thinking;
    setState((current) => {
      if (thinking) return 'thinking';
      return current === 'thinking' ? 'idle' : current;
    });
  }, []);

  const clearError = useCallback(() => {
    setError(null);
    setState((current) => (current === 'error' ? 'idle' : current));
  }, []);

  return {
    state,
    level,
    error,
    supported: support.supported,
    unsupportedReason,
    latency,
    toggle,
    cancel,
    speak,
    setThinking,
    clearError,
  };
}
