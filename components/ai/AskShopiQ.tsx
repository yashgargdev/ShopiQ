'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { cx } from '@/lib/format';
import { CloseIcon, MicIcon, SparkIcon } from '@/components/ui/icons';
import { AiChat } from './AiChat';

/**
 * The ShopiQ AI surface.
 *
 * The entry points are the design's — header button, floating action button,
 * product-page prompt chips, the mobile nav's centre slot. Phase 2 wires the
 * panel they open to the real agent at /api/ai/chat; the frame, palette and
 * motion are unchanged from the Claude Design source.
 *
 * Voice is still deliberately absent: the microphone is present but inert
 * until Phase 3 brings Sarvam speech in.
 */

interface AiPanelState {
  isOpen: boolean;
  open: (context?: string) => void;
  close: () => void;
  context: string | null;
}

const AiPanelContext = createContext<AiPanelState | null>(null);

export function AiPanelProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [context, setContext] = useState<string | null>(null);

  const open = useCallback((nextContext?: string) => {
    setContext(nextContext ?? null);
    setIsOpen(true);
  }, []);

  const close = useCallback(() => setIsOpen(false), []);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [isOpen, close]);

  const value = useMemo(() => ({ isOpen, open, close, context }), [isOpen, open, close, context]);

  return (
    <AiPanelContext.Provider value={value}>
      {children}
      <AiPanel />
    </AiPanelContext.Provider>
  );
}

export function useAiPanel(): AiPanelState {
  const value = useContext(AiPanelContext);
  if (!value) {
    throw new Error('useAiPanel must be used inside <AiPanelProvider>.');
  }
  return value;
}

/* ------------------------------------------------------------------ entry points */

export function AskShopiQButton({
  label = 'Ask ShopiQ',
  className,
  context,
}: {
  label?: string;
  className?: string;
  context?: string;
}) {
  const { open } = useAiPanel();
  return (
    <button
      type="button"
      onClick={() => open(context)}
      aria-label="Ask the ShopiQ AI assistant"
      className={cx(
        'inline-flex h-[38px] items-center gap-2 rounded-[10px] border border-[rgba(247,147,30,.42)] bg-[rgba(247,147,30,.1)] px-3.5 text-[13.5px] font-medium whitespace-nowrap text-[#FFC07A] transition-colors hover:border-[rgba(247,147,30,.7)] hover:bg-[rgba(247,147,30,.18)]',
        className,
      )}
    >
      <SparkIcon size={14} />
      {label}
    </button>
  );
}

/** The pulsing pill from the homepage AI preview card. */
export function TalkToShopiQButton({ className }: { className?: string }) {
  const { open } = useAiPanel();
  return (
    <button
      type="button"
      onClick={() => open()}
      className={cx(
        'animate-pulsering inline-flex h-11 items-center gap-2.5 rounded-full border border-[rgba(247,147,30,.4)] bg-[rgba(247,147,30,.09)] px-5.5 text-[14px] font-medium text-[#FFC07A] transition-colors hover:bg-[rgba(247,147,30,.18)]',
        className,
      )}
    >
      <MicIcon size={15} />
      Talk to ShopiQ
    </button>
  );
}

/** The suggestion chips on the product page. */
export function AiPromptChip({ children, context }: { children: ReactNode; context?: string }) {
  const { open } = useAiPanel();
  return (
    <button
      type="button"
      onClick={() => open(context)}
      className="rounded-full border border-white/14 bg-black/30 px-3.5 py-2 text-[13px] text-[#C6C6CC] transition-colors hover:border-[rgba(247,147,30,.5)] hover:text-white"
    >
      {children}
    </button>
  );
}

/** Fixed bottom-right action button, hidden on small screens where the mobile nav takes over. */
export function AskShopiQFab() {
  const { open } = useAiPanel();
  return (
    <button
      type="button"
      onClick={() => open()}
      aria-label="Ask ShopiQ"
      className="fixed bottom-6 right-6 z-90 hidden h-[52px] items-center gap-2.5 rounded-full brand-gradient pl-4 pr-5 text-[14.5px] font-semibold text-[#1A0D02] shadow-[0_14px_40px_-12px_rgba(247,147,30,.75)] transition-[filter,transform] hover:-translate-y-px hover:brightness-107 md:inline-flex"
    >
      <SparkIcon size={17} />
      Ask ShopiQ
    </button>
  );
}

/* ------------------------------------------------------------------ the panel */

function AiPanel() {
  const { isOpen, close, context } = useAiPanel();
  if (!isOpen) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-100 bg-black/60 backdrop-blur-[3px]"
        onClick={close}
        aria-hidden="true"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="ShopiQ AI assistant"
        className="animate-slide-in-right fixed inset-x-3 bottom-3 top-auto z-101 flex max-h-[86vh] flex-col rounded-[20px] border border-[rgba(247,147,30,.3)] bg-[linear-gradient(180deg,#0D0D10,#07070A)] shadow-[0_40px_90px_-40px_rgba(247,147,30,.4)] sm:inset-x-auto sm:bottom-5 sm:right-5 sm:top-20 sm:max-h-none sm:w-[420px]"
      >
        <header className="flex items-center gap-2.5 border-b border-white/7 px-5 py-[18px]">
          <span className="grid h-7 w-7 place-items-center rounded-lg brand-gradient text-[#1A0D02]">
            <SparkIcon size={14} />
          </span>
          <div>
            <div className="text-[14.5px] font-medium leading-none">ShopiQ AI</div>
            <div className="mt-1.5 font-mono text-[11.5px] leading-none text-[#6E6E76]">
              answers from the live catalogue
            </div>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close assistant"
            className="ml-auto grid h-8 w-8 place-items-center rounded-[9px] border border-white/10 text-[#9A9AA2] transition-colors hover:text-white"
          >
            <CloseIcon size={15} />
          </button>
        </header>

        {/* Remounts per opened context so a product-page chip starts a fresh
            question rather than appending to a stale thread. */}
        <AiChat key={context ?? 'blank'} seedMessage={context} />
      </aside>
    </>
  );
}
