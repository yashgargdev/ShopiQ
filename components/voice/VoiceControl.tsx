'use client';

import { AlertIcon } from '@/components/ui/icons';
import { cx } from '@/lib/format';
import { VOICE_STATE_LABEL, type VoiceState } from '@/lib/voice/use-voice-session';

/**
 * The voice controls.
 *
 * Restrained on purpose: pitch black, one orange accent, a single moving
 * element. The brief was a premium Google-style product, not a sci-fi console,
 * so the visualiser reacts to the voice and nothing else animates.
 */

/* ------------------------------------------------------------ visualiser */

/**
 * Five bars that follow the live microphone level.
 *
 * The level is a real measurement from the recorder, not a decorative
 * animation — when it is flat, the customer can see that nothing is being
 * picked up, which is the fastest way to diagnose a muted microphone.
 */
export function VoiceVisualizer({
  level,
  active,
  className,
}: {
  level: number;
  active: boolean;
  className?: string;
}) {
  // Slight per-bar weighting so it reads as a voice rather than a slider.
  const weights = [0.55, 0.8, 1, 0.8, 0.55];

  return (
    <div
      className={cx('flex items-center justify-center gap-[3px]', className)}
      aria-hidden="true"
    >
      {weights.map((weight, index) => {
        const height = active ? 4 + Math.min(level * 3, 1) * 20 * weight : 4;
        return (
          <span
            key={index}
            className={cx(
              'w-[3px] rounded-full transition-[height] duration-100 ease-out',
              active ? 'bg-[#F7931E]' : 'bg-white/20',
            )}
            style={{ height: `${height}px` }}
          />
        );
      })}
    </div>
  );
}

/* ----------------------------------------------------------------- status */

export function VoiceStatus({ state, error }: { state: VoiceState; error?: string | null }) {
  if (state === 'idle') return null;

  const isError = state === 'error';
  return (
    <div
      role="status"
      aria-live="polite"
      className={cx(
        'flex items-center gap-1.5 text-[11.5px] leading-snug',
        isError ? 'text-[#FF8B8B]' : 'text-[#8A8A93]',
      )}
    >
      {isError ? <AlertIcon size={11} className="shrink-0" /> : null}
      {isError ? (error ?? VOICE_STATE_LABEL.error) : VOICE_STATE_LABEL[state]}
    </div>
  );
}

/* ---------------------------------------------------------------- control */

export function VoiceControl({
  state,
  level,
  error,
  supported,
  unsupportedReason,
  onToggle,
  onRetry,
  onTypeInstead,
  compact = false,
}: {
  state: VoiceState;
  level: number;
  error: string | null;
  supported: boolean;
  unsupportedReason: string | null;
  onToggle: () => void;
  onRetry: () => void;
  onTypeInstead: () => void;
  compact?: boolean;
}) {
  // Voice is never the only way in. When it is unavailable, the panel says so
  // once and gets out of the way — the text box is right there.
  if (!supported) {
    return (
      <p className="m-0 flex items-start gap-1.5 text-[11px] leading-snug text-[#6E6E76]">
        <AlertIcon size={11} className="mt-0.5 shrink-0" />
        {unsupportedReason ?? "Voice isn't available in this browser."}
      </p>
    );
  }

  const listening = state === 'listening';
  const speaking = state === 'speaking';
  const working = state === 'transcribing' || state === 'thinking';

  const label = listening
    ? 'Stop listening'
    : speaking
      ? 'Interrupt ShopiQ and talk'
      : 'Talk to ShopiQ';

  if (state === 'error') {
    return (
      <div className="flex flex-col gap-2">
        <VoiceStatus state={state} error={error} />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex h-7 items-center rounded-[8px] border border-white/12 px-3 text-[11.5px] font-medium text-[#EDEDF0] transition-colors hover:border-white/28"
          >
            Try Again
          </button>
          <button
            type="button"
            onClick={onTypeInstead}
            className="inline-flex h-7 items-center rounded-[8px] border border-white/12 px-3 text-[11.5px] font-medium text-[#C6C6CC] transition-colors hover:border-white/28 hover:text-white"
          >
            Type Instead
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={cx('flex items-center gap-2.5', compact && 'gap-2')}>
      <button
        type="button"
        onClick={onToggle}
        disabled={working}
        aria-label={label}
        aria-pressed={listening}
        className={cx(
          'group relative grid shrink-0 place-items-center rounded-full transition-all',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F7931E]',
          compact ? 'h-9 w-9' : 'h-10 w-10',
          listening
            ? 'brand-gradient text-[#1A0D02]'
            : 'border border-white/12 bg-[#101014] text-[#C6C6CC] hover:border-white/28 hover:text-white',
          working && 'cursor-not-allowed opacity-60',
        )}
      >
        {listening ? (
          // A square reads as "stop" without needing a label.
          <span className="h-3 w-3 rounded-[3px] bg-[#1A0D02]" />
        ) : (
          <MicIcon size={compact ? 15 : 16} />
        )}

        {/* One soft ring while listening — the only ambient motion. */}
        {listening ? (
          <span className="pointer-events-none absolute inset-0 animate-ping rounded-full bg-[rgba(247,147,30,.35)] [animation-duration:1.8s]" />
        ) : null}
      </button>

      <div className="flex min-w-0 flex-col gap-1">
        {listening ? (
          <VoiceVisualizer level={level} active />
        ) : (
          <span className="text-[11.5px] text-[#8A8A93]">
            {state === 'idle' ? VOICE_STATE_LABEL.idle : null}
          </span>
        )}
        {state !== 'idle' ? <VoiceStatus state={state} error={error} /> : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- icon */

function MicIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  );
}
