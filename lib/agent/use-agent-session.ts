'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { VoiceRecorder, RecorderError, microphoneSupported } from '@/lib/voice/recorder';
import { launchPayment } from '@/lib/payments/checkout-client';

/**
 * The agent session.
 *
 * One state machine owns the microphone, the transcription request, the audio
 * element and the checkout step, because these fight when owned separately:
 * audio keeps playing over a new recording, two recordings overlap on a double
 * tap, a stale reply speaks after the customer has moved on.
 *
 * It calls the SAME endpoints the rest of ShopiQ uses. There is no shopping
 * logic here — no search, no cart maths, no totals. This file decides what to
 * show and when to listen; the server decides what is true.
 */

export type AgentState =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'speaking'
  | 'waiting_for_user'
  | 'checkout'
  | 'payment'
  | 'success'
  | 'error';

/** Which transitions are legal. A stray call cannot skip the customer's yes. */
const ALLOWED: Record<AgentState, AgentState[]> = {
  idle: ['listening', 'thinking', 'checkout', 'error'],
  listening: ['transcribing', 'idle', 'error'],
  transcribing: ['thinking', 'error', 'idle'],
  thinking: ['speaking', 'waiting_for_user', 'checkout', 'error', 'idle'],
  speaking: ['idle', 'listening', 'waiting_for_user', 'checkout', 'error'],
  waiting_for_user: ['listening', 'thinking', 'checkout', 'idle', 'error'],
  checkout: ['thinking', 'listening', 'payment', 'waiting_for_user', 'idle', 'error'],
  payment: ['success', 'checkout', 'error', 'idle'],
  success: ['idle', 'listening', 'thinking'],
  error: ['idle', 'listening', 'thinking'],
};

export const AGENT_PROMPT: Record<AgentState, string> = {
  idle: 'What are you looking for?',
  listening: "I'm listening…",
  transcribing: 'Understanding…',
  thinking: 'Let me find that for you…',
  speaking: '',
  waiting_for_user: 'What would you like to do?',
  checkout: "Let's complete your order.",
  payment: 'Opening secure payment…',
  success: 'Order successful.',
  error: 'Something went wrong. Try again.',
};

export interface AgentTurn {
  id: string;
  role: 'user' | 'agent';
  text: string;
  products?: any[];
  comparison?: any;
  cart?: any;
  type?: string;
}

export interface CheckoutDetails {
  isGuest: boolean;
  missing: string[];
  details: {
    fullName: string | null;
    email: string | null;
    phone: string | null;
    address: Record<string, any> | null;
  };
}

export interface AgentQuote {
  confirmationId: string;
  amountMinor: number;
  amountDisplay: string;
  items: Array<{ name: string; quantity: number; unit_price_minor: number }>;
  subtotalMinor: number;
  shippingMinor: number;
  deliveryEstimate: string;
  address: Record<string, any> | null;
}

export interface AgentOrder {
  orderNumber: string;
  orderId: string;
  totalDisplay: string;
  deliveryEstimate: string;
  invoiceEmail: string | null;
}

export function useAgentSession() {
  const [state, setStateRaw] = useState<AgentState>('idle');
  const [level, setLevel] = useState(0);
  const [turns, setTurns] = useState<AgentTurn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [language, setLanguage] = useState<string | null>(null);
  const [checkout, setCheckout] = useState<CheckoutDetails | null>(null);
  const [quote, setQuote] = useState<AgentQuote | null>(null);
  const [order, setOrder] = useState<AgentOrder | null>(null);

  const recorderRef = useRef<VoiceRecorder | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const busyRef = useRef(false);
  /**
   * True between "start requested" and "recorder actually running".
   *
   * getUserMedia is asynchronous, so a second tap arriving during that window
   * would open a second capture session and leave the first orphaned — the UI
   * then says "Listening" with a recorder nobody can stop. Taps in that window
   * are dropped rather than queued.
   */
  const startingRef = useRef(false);
  const stateRef = useRef<AgentState>('idle');

  /**
   * Microphone support is detected AFTER mount, never during render.
   *
   * Branching on `typeof window` inside render makes the server and the first
   * client pass disagree — the server says "no microphone", the browser says
   * "yes" — and React discards the tree with a hydration error. Starting from
   * a value both sides agree on and correcting it in an effect is the fix.
   */
  const [micSupported, setMicSupported] = useState(false);
  useEffect(() => {
    setMicSupported(microphoneSupported().supported);
  }, []);

  /** Guarded transition. An illegal move is ignored rather than applied. */
  const setState = useCallback((next: AgentState) => {
    const current = stateRef.current;
    if (current === next) return;
    if (!ALLOWED[current]?.includes(next)) {
      // Not thrown: an out-of-order async reply is normal, and dropping it is
      // the correct handling — but it must never silently rewrite the state.
      console.warn(`[agent] refused transition ${current} → ${next}`);
      return;
    }
    stateRef.current = next;
    setStateRaw(next);
  }, []);

  const stopPlayback = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.onended = null;
      audio.onerror = null;
      audio.src = '';
      audioRef.current = null;
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, []);

  const cleanup = useCallback(() => {
    recorderRef.current?.cancel();
    recorderRef.current = null;
    stopPlayback();
    busyRef.current = false;
    startingRef.current = false;
    setLevel(0);
  }, [stopPlayback]);

  // Nothing outlives the page: a microphone still open or audio still playing
  // after navigation is something the customer can hear.
  useEffect(() => cleanup, [cleanup]);

  const speak = useCallback(
    async (text: string, lang?: string | null) => {
      if (!text.trim()) return;
      stopPlayback();

      let response: Response;
      try {
        response = await fetch('/api/voice/synthesize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, conversationId, language: lang ?? undefined }),
        });
      } catch {
        return; // TTS is a convenience; the text is already on screen.
      }
      if (!response.ok) return;

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      setState('speaking');

      await new Promise<void>((resolve) => {
        const finish = () => {
          stopPlayback();
          if (stateRef.current === 'speaking') setState('waiting_for_user');
          resolve();
        };
        audio.onended = finish;
        audio.onerror = finish;
        void audio.play().catch(finish);
      });
    },
    [conversationId, setState, stopPlayback],
  );

  /** Send a message to the SAME chat endpoint the rest of ShopiQ uses. */
  const send = useCallback(
    async (text: string, inputMode: 'voice' | 'text' = 'voice', lang?: string | null) => {
      if (!text.trim()) return null;
      setTurns((current) => [...current, { id: `u-${Date.now()}`, role: 'user', text }]);
      setState('thinking');
      busyRef.current = true;

      try {
        const response = await fetch('/api/ai/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversationId,
            message: text,
            inputMode,
            ...(lang ? { language: lang } : {}),
          }),
        });
        const payload = await response.json().catch(() => null);

        if (!response.ok || !payload || payload.error) {
          setError(payload?.error?.message ?? 'ShopiQ could not answer just now.');
          setState('error');
          return null;
        }

        setConversationId(payload.conversationId);
        setTurns((current) => [
          ...current,
          {
            id: `a-${Date.now()}`,
            role: 'agent',
            text: payload.message,
            products: payload.products,
            comparison: payload.comparison,
            cart: payload.cart,
            type: payload.type,
          },
        ]);

        if (payload.speech) await speak(payload.speech, lang ?? language);
        else setState('waiting_for_user');

        return payload;
      } catch {
        setError('Could not reach ShopiQ. Check your connection.');
        setState('error');
        return null;
      } finally {
        busyRef.current = false;
      }
    },
    [conversationId, language, setState, speak],
  );

  const submitRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    recorderRef.current = null;

    // Reaching here with nothing recording means the state machine and the
    // recorder disagreed. Recover to a usable state rather than stranding the
    // customer on a screen that says it is listening when it is not.
    if (!recorder) {
      busyRef.current = false;
      startingRef.current = false;
      setLevel(0);
      stateRef.current = 'waiting_for_user';
      setStateRaw('waiting_for_user');
      return;
    }

    const recording = await recorder.stop();
    setLevel(0);

    if (!recording || recording.peak < 0.01) {
      setError("I didn't quite catch that. Please try again.");
      setState('error');
      busyRef.current = false;
      return;
    }

    setState('transcribing');
    const form = new FormData();
    form.append('audio', recording.blob, 'speech.wav');
    if (conversationId) form.append('conversationId', conversationId);

    try {
      const response = await fetch('/api/voice/transcribe', { method: 'POST', body: form });
      const payload = await response.json().catch(() => null);

      if (!response.ok || !payload?.transcript?.text) {
        setError(payload?.error?.message ?? "I didn't quite catch that. Please try again.");
        setState('error');
        busyRef.current = false;
        return;
      }

      const detected = payload.transcript.language ?? null;
      if (detected) setLanguage(detected);
      await send(payload.transcript.text, 'voice', detected);
    } catch {
      setError("I didn't quite catch that. Please try again.");
      setState('error');
      busyRef.current = false;
    }
  }, [conversationId, send, setState]);

  const toggleMic = useCallback(() => {
    setError(null);
    const current = stateRef.current;

    // Already recording → stop and submit. Checked FIRST, and against the
    // state as it was on entry: an earlier version set 'listening' while
    // handling an interrupt and then fell into this branch in the same tick,
    // submitting a recording that had never been started and leaving the UI
    // stuck on "Listening…" forever.
    if (current === 'listening') {
      void submitRecording();
      return;
    }

    // Interrupting is the point: pressing while ShopiQ talks stops the audio
    // and starts a NEW recording. The reply being abandoned is also why
    // busyRef has to be released here — it is still set from the turn that
    // produced the speech, and would otherwise block the microphone.
    if (current === 'speaking') {
      stopPlayback();
      busyRef.current = false;
    }

    // A tap while the microphone is still opening is ignored, not queued.
    if (startingRef.current) return;
    if (busyRef.current) return;

    if (!micSupported) {
      setError("I can't access your microphone. You can type instead.");
      setState('error');
      return;
    }

    busyRef.current = true;
    startingRef.current = true;
    const recorder = new VoiceRecorder();
    recorderRef.current = recorder;
    recorder
      .start((peak) => setLevel(peak))
      .then(() => {
        startingRef.current = false;
        stateRef.current = 'listening';
        setStateRaw('listening');
      })
      .catch((cause: unknown) => {
        startingRef.current = false;
        recorderRef.current = null;
        busyRef.current = false;
        setError(
          cause instanceof RecorderError
            ? cause.message
            : "I can't access your microphone. You can type instead.",
        );
        setState('error');
      });
  }, [micSupported, setState, stopPlayback, submitRecording]);

  // ------------------------------------------------------------- checkout

  const callCheckout = useCallback(
    async (body: Record<string, unknown>) => {
      const response = await fetch('/api/agent/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId, ...body }),
      });
      return response.json().catch(() => null);
    },
    [conversationId],
  );

  const refreshCheckout = useCallback(async () => {
    const result = await callCheckout({ action: 'status' });
    if (result?.ok) {
      setCheckout({ isGuest: result.isGuest, missing: result.missing, details: result.details });
    }
    return result;
  }, [callCheckout]);

  const collectDetail = useCallback(
    async (patch: Record<string, unknown>) => {
      const result = await callCheckout({ action: 'collect', ...patch });
      if (result?.ok) {
        setCheckout({ isGuest: result.isGuest ?? true, missing: result.missing, details: result.details });
      }
      return result;
    },
    [callCheckout],
  );

  const useCurrentLocation = useCallback(async (): Promise<{ ok: boolean; message: string }> => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      return { ok: false, message: "I can't access location here. Please tell me your address." };
    }

    // Permission is always requested explicitly by this call — nothing reads
    // location in the background.
    const position = await new Promise<GeolocationPosition | null>((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (value) => resolve(value),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
      );
    });

    if (!position) {
      return {
        ok: false,
        message: "That's okay. Please tell me your delivery address.",
      };
    }

    const result = await callCheckout({
      action: 'locate',
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
    });

    if (result?.ok) {
      setCheckout({ isGuest: true, missing: result.missing, details: result.details });
      return { ok: true, message: 'Got it — I have your delivery address.' };
    }
    return {
      ok: false,
      message: result?.message ?? "I couldn't work out your address. Please tell me instead.",
    };
  }, [callCheckout]);

  /** Ask the server for the authoritative total. Never computed here. */
  const requestQuote = useCallback(async () => {
    setState('checkout');
    const result = await callCheckout({ action: 'quote' });
    if (!result?.ok) {
      if (result?.missing) {
        setCheckout((current) => (current ? { ...current, missing: result.missing } : current));
      }
      return result;
    }

    setQuote({
      confirmationId: result.confirmation.id,
      amountMinor: result.confirmation.amount_minor,
      amountDisplay: result.confirmation.amount_display,
      items: result.confirmation.items,
      subtotalMinor: result.confirmation.subtotal_minor,
      shippingMinor: result.confirmation.shipping_minor,
      deliveryEstimate: result.deliveryEstimate,
      address: result.details?.address ?? null,
    });
    setCheckout({ isGuest: result.isGuest, missing: result.missing, details: result.details });
    await speak(result.message, language);
    return result;
  }, [callCheckout, language, setState, speak]);

  /**
   * The customer's explicit yes, then Razorpay.
   *
   * The confirmation is granted server-side first; `launchPayment` then goes
   * through the existing Phase 4 create → checkout → verify path, which
   * re-runs every one of its seventeen checks. Nothing here can shortcut it.
   */
  const confirmAndPay = useCallback(async () => {
    if (!quote) return { ok: false as const, message: 'There is no total to confirm yet.' };

    const granted = await callCheckout({ action: 'confirm', confirmationId: quote.confirmationId });
    if (!granted?.ok) {
      await speak(granted?.message ?? 'Let me work out the total again.', language);
      setQuote(null);
      setState('checkout');
      return { ok: false as const, message: granted?.message ?? 'Confirmation failed.' };
    }

    setState('payment');

    // Create the provider order through the existing Phase 4 endpoint. It
    // re-runs all seventeen authorization checks; nothing here can skip them,
    // and the amount comes back from the server rather than going to it.
    const createResponse = await fetch('/api/payments/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmationId: quote.confirmationId, conversationId }),
    });
    const created = await createResponse.json().catch(() => null);

    if (!createResponse.ok || !created?.payment) {
      const message =
        created?.error?.message ?? "I couldn't start the payment. Nothing has been charged.";
      await speak(message, language);
      setState('checkout');
      return { ok: false as const, message };
    }

    const payment = created.payment;
    const result = await launchPayment({
      provider: payment.provider,
      publicKey: payment.key,
      providerOrderId: payment.provider_order_id,
      amountMinor: payment.amount,
      currency: payment.currency,
      customerName: checkout?.details.fullName ?? payment.customer?.name ?? null,
      customerEmail: checkout?.details.email ?? payment.customer?.email ?? null,
      conversationId,
    });

    if (result.status === 'succeeded') {
      setOrder({
        orderNumber: result.orderNumber,
        orderId: result.orderId,
        totalDisplay: result.totalDisplay ?? quote.amountDisplay,
        deliveryEstimate: quote.deliveryEstimate,
        invoiceEmail: checkout?.details.email ?? null,
      });
      setState('success');
      setQuote(null);
      await speak(result.message, language);
      return { ok: true as const, result };
    }

    // Everything else — cancelled, failed, verification pending — returns the
    // customer to checkout with the cart intact.
    await speak(result.message, language);
    setState('checkout');
    return { ok: false as const, message: result.message, status: result.status };
  }, [callCheckout, checkout, conversationId, language, quote, setState, speak]);

  const reset = useCallback(() => {
    stopPlayback();
    setQuote(null);
    setOrder(null);
    setError(null);
    stateRef.current = 'idle';
    setStateRaw('idle');
  }, [stopPlayback]);

  return {
    state,
    level,
    turns,
    error,
    language,
    conversationId,
    checkout,
    quote,
    order,
    micSupported,
    toggleMic,
    send,
    speak,
    refreshCheckout,
    collectDetail,
    useCurrentLocation,
    requestQuote,
    confirmAndPay,
    reset,
    clearError: () => {
      setError(null);
      if (stateRef.current === 'error') {
        stateRef.current = 'idle';
        setStateRaw('idle');
      }
    },
  };
}
