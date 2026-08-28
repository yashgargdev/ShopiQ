'use client';

import { cx } from '@/lib/format';

/**
 * The ShopiQ orb.
 *
 * It represents ShopiQ itself, not a product. Built from layered radial
 * gradients rather than an image or a canvas, so it stays sharp at any size,
 * costs nothing to load, and animates on the compositor.
 *
 * Restraint is the brief: one moving element, no neon, no glassmorphism. The
 * only thing that reacts in real time is the microphone level, because that is
 * the one signal the customer actually needs — a flat orb while they are
 * talking tells them the microphone is muted.
 */

export type OrbState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';

export function AgentOrb({
  state,
  level = 0,
  size = 200,
}: {
  state: OrbState;
  /** Live microphone or playback level, 0–1. */
  level?: number;
  size?: number;
}) {
  // Listening and speaking scale with real audio; the other states breathe on
  // their own schedule.
  const reactive = state === 'listening' || state === 'speaking';
  const scale = reactive ? 1 + Math.min(level * 1.6, 1) * 0.13 : 1;
  const glow = reactive ? 0.35 + Math.min(level * 2, 1) * 0.45 : 0.3;

  return (
    <div
      className="relative grid place-items-center"
      style={{ width: size, height: size }}
      role="img"
      aria-label={`ShopiQ is ${state}`}
    >
      {/* Outer halo — soft, and the only thing that reads as "alive" at rest.
          It cycles with the sphere while thinking so the glow never fights the
          colour it is supposed to be coming from. */}
      <div
        className={cx(
          'absolute inset-0 rounded-full blur-2xl transition-opacity duration-500',
          state === 'error' ? 'bg-[rgba(255,107,107,.35)]' : 'bg-[rgba(247,147,30,.28)]',
          state === 'idle' && 'agent-breathe',
          state === 'thinking' && 'agent-spin',
        )}
        style={{ opacity: glow }}
      />

      {/*
        Working indicator.

        The hue shift alone was too subtle to read as "busy" — someone waiting
        several seconds on a live model needs to see that something is
        happening, or they tap again and start over. One thin arc, sized
        against the OUTER box so its percentages mean what they say.
      */}
      {state === 'thinking' ? (
        <svg
          className="agent-ring pointer-events-none absolute inset-0"
          viewBox="0 0 100 100"
          fill="none"
          aria-hidden="true"
        >
          <circle cx="50" cy="50" r="43" stroke="rgba(247,147,30,.18)" strokeWidth="1.5" />
          <circle
            cx="50"
            cy="50"
            r="43"
            stroke="#F7931E"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeDasharray="48 222"
          />
        </svg>
      ) : null}

      {/* The sphere */}
      <div
        className={cx(
          'relative rounded-full transition-transform duration-150 ease-out',
          state === 'idle' && 'agent-breathe',
          state === 'thinking' && 'agent-spin',
        )}
        style={{
          width: size * 0.72,
          height: size * 0.72,
          transform: `scale(${scale})`,
          background:
            state === 'error'
              ? 'radial-gradient(circle at 32% 28%, #FFB4B4 0%, #FF6B6B 38%, #7A1F1F 78%, #2A0B0B 100%)'
              : // Indigo core with warm ShopiQ edge lighting — the brand colour
                // arrives as a rim light rather than a flood, which is what keeps
                // it premium rather than neon.
                'radial-gradient(circle at 32% 28%, #A7B6FF 0%, #4F5BD5 34%, #2A2E86 62%, #120C2E 88%), radial-gradient(circle at 78% 82%, rgba(247,147,30,.85) 0%, rgba(247,147,30,0) 55%)',
          backgroundBlendMode: 'screen',
          boxShadow:
            state === 'error'
              ? '0 0 60px rgba(255,107,107,.35), inset 0 -10px 30px rgba(0,0,0,.5)'
              : '0 0 70px rgba(79,91,213,.35), 0 0 40px rgba(247,147,30,.2), inset 0 -12px 34px rgba(0,0,0,.55)',
        }}
      >
        {/* Specular highlight */}
        <span
          className="absolute rounded-full bg-white/70 blur-md"
          style={{ width: '18%', height: '13%', left: '22%', top: '17%', opacity: 0.5 }}
        />
      </div>

      <style jsx>{`
        .agent-breathe {
          animation: agent-breathe 4.5s ease-in-out infinite;
        }
        /*
          Thinking state: a continuous hue sweep.

          A full 360° cycle, slow enough (7s) to read as the orb breathing
          through colour rather than strobing. The saturation lift keeps the
          mid-cycle hues from going muddy against the dark background.
        */
        .agent-spin {
          animation: agent-spin 7s linear infinite;
        }
        .agent-ring {
          animation: agent-ring 1.15s linear infinite;
          transform-origin: 50% 50%;
        }
        @keyframes agent-breathe {
          0%,
          100% {
            transform: scale(1);
          }
          50% {
            transform: scale(1.045);
          }
        }
        @keyframes agent-spin {
          0% {
            filter: hue-rotate(0deg) saturate(1.05);
          }
          50% {
            filter: hue-rotate(180deg) saturate(1.25);
          }
          100% {
            filter: hue-rotate(360deg) saturate(1.05);
          }
        }
        @keyframes agent-ring {
          from {
            transform: rotate(0deg);
          }
          to {
            transform: rotate(360deg);
          }
        }
        /* Motion is decorative here; the state is always also written in text. */
        @media (prefers-reduced-motion: reduce) {
          .agent-breathe,
          .agent-spin,
          .agent-ring {
            animation: none;
          }
        }
      `}</style>
    </div>
  );
}

/** A thin waveform that follows the live level. Purely indicative. */
export function AgentWaveform({ level, active }: { level: number; active: boolean }) {
  const bars = 28;
  return (
    <div className="flex h-8 items-center justify-center gap-[3px]" aria-hidden="true">
      {Array.from({ length: bars }, (_, index) => {
        // A soft bell across the row so the middle moves most — reads as a
        // voice rather than a graphic equaliser.
        const distance = Math.abs(index - (bars - 1) / 2) / ((bars - 1) / 2);
        const weight = 1 - distance * 0.75;
        const height = active ? 3 + Math.min(level * 2.2, 1) * 26 * weight : 3;
        return (
          <span
            key={index}
            className={cx(
              'w-[2px] rounded-full transition-[height] duration-100 ease-out',
              active ? 'bg-[#F7931E]' : 'bg-white/15',
            )}
            style={{ height }}
          />
        );
      })}
    </div>
  );
}
