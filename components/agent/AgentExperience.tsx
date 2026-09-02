'use client';

import { formatOrderNumber } from '@/lib/orders/number';
import Image from 'next/image';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AgentOrb, AgentWaveform } from './AgentOrb';
import { AgentHeader } from './AgentHeader';
import { AGENT_PROMPT, useAgentSession } from '@/lib/agent/use-agent-session';
import { cx, formatPrice } from '@/lib/format';

/**
 * The full-screen ShopiQ voice agent.
 *
 * Everything visible here is driven by the session hook, which in turn calls
 * the same endpoints the rest of ShopiQ uses. This component contains no
 * shopping logic: no search, no cart arithmetic, no totals. It decides what to
 * SHOW; the server decides what is true.
 *
 * The layout is one column on a phone and stays one column on a desktop — the
 * brief is explicitly not to grow a storefront at wide viewports.
 */

const SUGGESTIONS = [
  'Mujhe 50 hazaar ke andar laptop chahiye',
  'Suggest me a laptop under 50k',
  'Show me headphones for travel',
];

function MicIcon({ size = 22 }: { size?: number }) {
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
      aria-hidden="true"
    >
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  );
}

export function AgentExperience() {
  const agent = useAgentSession();
  const [typed, setTyped] = useState('');
  const [showTranscript, setShowTranscript] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);

  const {
    state,
    level,
    turns,
    error,
    checkout,
    quote,
    order,
    micSupported,
  } = agent;

  // The latest agent turn drives what is shown beside the orb.
  const latest = useMemo(() => [...turns].reverse().find((t) => t.role === 'agent'), [turns]);
  const products = latest?.products ?? [];
  const comparison = latest?.comparison ?? null;
  const cart = latest?.cart ?? null;

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns, showTranscript]);

  /**
   * Drive the checkout step when the conversation reaches it.
   *
   * The agent turn tells us the customer wants to buy; this asks the SERVER
   * for the authoritative total once every delivery detail is present. Without
   * it the customer says "proceed to checkout" and nothing appears to confirm,
   * so payment can never open.
   */
  useEffect(() => {
    const wantsCheckout =
      latest?.type === 'checkout' || latest?.type === 'purchase_confirmation';
    if (!wantsCheckout) return;

    let cancelled = false;
    void (async () => {
      const status = await agent.refreshCheckout();
      if (cancelled) return;
      // Only quote once nothing is outstanding — otherwise the detail prompt
      // is what should be on screen.
      if (status?.ok && (status.missing ?? []).length === 0) {
        await agent.requestQuote();
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latest?.id, latest?.type]);

  /**
   * As soon as the last missing detail is collected, ask for the total.
   * The customer has already said they want to check out; making them repeat
   * themselves after typing their address would be its own small failure.
   */
  useEffect(() => {
    if (!checkout || quote) return;
    if (checkout.missing.length > 0) return;
    if (state !== 'checkout' && state !== 'waiting_for_user') return;
    void agent.requestQuote();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkout?.missing.length, quote]);

  const submitTyped = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const text = typed.trim();
      if (!text) return;
      setTyped('');
      void agent.send(text, 'text');
    },
    [agent, typed],
  );

  const orbState =
    state === 'listening'
      ? 'listening'
      : state === 'speaking'
        ? 'speaking'
        : state === 'thinking' || state === 'transcribing' || state === 'payment'
          ? 'thinking'
          : state === 'error'
            ? 'error'
            : 'idle';

  const listening = state === 'listening';
  const busy = state === 'thinking' || state === 'transcribing' || state === 'payment';

  /**
   * Why voice is unavailable, named accurately — resolved AFTER mount.
   *
   * This must never be computed during render. `window.isSecureContext` is
   * false on a LAN address over http and true on localhost, so a render-time
   * branch makes the server and the phone produce different HTML. React then
   * fails hydration and the entire page stops responding — no chat, no cart,
   * no checkout — on exactly the devices where the branch differs. The symptom
   * looks nothing like its cause, which is what made it worth a comment.
   */
  const [micReason, setMicReason] = useState(
    "Voice isn't available here — you can type instead.",
  );
  useEffect(() => {
    setMicReason(
      window.isSecureContext
        ? "Voice isn't available in this browser — you can type instead."
        : 'Voice needs a secure connection. Open ShopiQ over https, or on localhost — you can type here in the meantime.',
    );
  }, []);

  /* ------------------------------------------------------------ success */
  if (state === 'success' && order) {
    return (
      <main className="agent-shell flex flex-col items-center justify-center px-6 text-center">
        <div className="grid h-16 w-16 place-items-center rounded-full border border-[rgba(247,147,30,.4)] bg-[rgba(247,147,30,.1)]">
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#F7931E" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </div>

        <h1 className="mt-6 text-[26px] font-semibold tracking-tight text-white">Order successful</h1>
        <p className="mt-2 font-mono text-[15px] text-[#F7931E]">{formatOrderNumber(order.orderNumber)}</p>

        <dl className="mt-8 w-full max-w-xs space-y-4 text-[13.5px]">
          <div>
            <dt className="text-[#7E7E88]">Total paid</dt>
            <dd className="mt-0.5 text-[17px] font-semibold text-white">{order.totalDisplay}</dd>
          </div>
          <div>
            <dt className="text-[#7E7E88]">Expected delivery</dt>
            <dd className="mt-0.5 text-white">{order.deliveryEstimate}</dd>
          </div>
          {order.invoiceEmail ? (
            <div>
              <dt className="text-[#7E7E88]">Invoice sent to</dt>
              <dd className="mt-0.5 break-all text-white">{order.invoiceEmail}</dd>
            </div>
          ) : null}
        </dl>

        <div className="mt-9 flex flex-col items-center gap-3">
          <button
            type="button"
            onClick={agent.reset}
            className="inline-flex h-11 items-center gap-2 rounded-full brand-gradient px-6 text-[14px] font-semibold text-[#1A0D02]"
          >
            <MicIcon size={16} />
            Continue talking to ShopiQ
          </button>
          {/* Asks the assistant rather than navigating: there is no order
              page in this product, and the agent can answer from live data. */}
          <button
            type="button"
            onClick={() => {
              agent.reset();
              void agent.send(`What is the status of order ${formatOrderNumber(order.orderNumber)}?`, 'text');
            }}
            className="text-[13px] text-[#8A8A93] underline-offset-4 hover:underline"
          >
            Track this order
          </button>
        </div>
        <AgentShellStyles />
      </main>
    );
  }

  /* ------------------------------------------------------------- main */
  return (
    <main className="agent-shell relative flex flex-col">
      <AgentHeader
        transcriptOpen={showTranscript}
        onToggleTranscript={() => setShowTranscript((current) => !current)}
      />

      {/* Orb + state */}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 py-4">
        <AgentOrb state={orbState} level={level} size={172} />

        <div className="mt-7 min-h-[3.5rem] max-w-md text-center" role="status" aria-live="polite">
          {state === 'error' && error ? (
            <p className="text-[15px] leading-snug text-[#FF8B8B]">{error}</p>
          ) : busy ? (
            // Always say what is happening while work is in flight — a silent
            // screen is what makes people tap again and start over.
            <p className="flex items-center justify-center gap-2 text-[17px] font-medium leading-snug text-white">
              <span className="agent-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              {AGENT_PROMPT[state]}
            </p>
          ) : latest && (state === 'speaking' || state === 'waiting_for_user') ? (
            <p className="text-[16px] leading-snug text-white">{latest.text}</p>
          ) : (
            <p className="text-[19px] font-medium leading-snug text-white">{AGENT_PROMPT[state]}</p>
          )}
        </div>

        {listening ? <AgentWaveform level={level} active /> : null}

        {/* First-run suggestions, gone as soon as the conversation starts */}
        {turns.length === 0 && state === 'idle' ? (
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            {SUGGESTIONS.map((text) => (
              <button
                key={text}
                type="button"
                onClick={() => void agent.send(text, 'text')}
                className="rounded-full border border-white/10 px-3.5 py-2 text-[12.5px] text-[#C6C6CC] transition-colors hover:border-[rgba(247,147,30,.45)] hover:text-white"
              >
                {text}
              </button>
            ))}
          </div>
        ) : null}

        {/* Contextual commerce — only ever what the last turn produced */}
        <div className="mt-7 w-full max-w-2xl">
          {comparison ? <AgentComparison comparison={comparison} /> : null}

          {/*
            After an add, the same payload carries the cross-sell suggestions
            the Phase 3 engine ranked — real accessories from real category
            pairings, not a generic "you may also like". Labelling them is the
            difference between a suggestion and a second product grid.
          */}
          {!comparison && products.length > 0 ? (
            <AgentProductRail
              products={products}
              heading={
                latest?.type === 'cart'
                  ? 'Goes well with this'
                  : latest?.type === 'product_recommendations'
                    ? null
                    : null
              }
              onAdd={(product) => void agent.send(`add the ${product.name}`, 'text')}
            />
          ) : null}

          {cart && !quote ? <AgentCartStrip cart={cart} /> : null}
          {checkout && checkout.isGuest && checkout.missing.length > 0 && !quote ? (
            <AgentDetailPrompt agent={agent} missing={checkout.missing} />
          ) : null}
          {quote ? <AgentQuoteCard agent={agent} quote={quote} busy={state === 'payment'} /> : null}
          <AgentAccountLinks actions={latest?.actions ?? []} />
        </div>
      </div>

      {/* Transcript */}
      {showTranscript ? (
        <div
          ref={transcriptRef}
          className="max-h-[34vh] shrink-0 overflow-y-auto border-t border-white/8 px-5 py-4"
        >
          <ol className="mx-auto max-w-2xl space-y-3">
            {turns.map((turn) => (
              <li key={turn.id} className="text-[13px] leading-relaxed">
                <span className={turn.role === 'user' ? 'text-[#7E7E88]' : 'text-[#F7931E]'}>
                  {turn.role === 'user' ? 'You' : 'ShopiQ'}
                </span>
                <p className="mt-0.5 text-[#EDEDF0]">{turn.text}</p>
              </li>
            ))}
            {turns.length === 0 ? (
              <li className="text-[13px] text-[#7E7E88]">Nothing said yet.</li>
            ) : null}
          </ol>
        </div>
      ) : null}

      {/* Bottom control */}
      <div className="shrink-0 px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3">
        <div className="mx-auto flex max-w-2xl flex-col gap-3">
          {micSupported ? (
            <button
              type="button"
              onClick={agent.toggleMic}
              disabled={busy}
              aria-label={listening ? 'Stop listening' : 'Talk to ShopiQ'}
              aria-pressed={listening}
              className={cx(
                'flex h-14 w-full items-center justify-center gap-3 rounded-full text-[15px] font-semibold transition-all',
                'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F7931E]',
                listening
                  ? 'brand-gradient text-[#1A0D02]'
                  : 'border border-white/12 bg-[#0C0C0F] text-white hover:border-white/28',
                busy && 'cursor-not-allowed opacity-55',
              )}
            >
              {listening ? (
                <>
                  <span className="h-3.5 w-3.5 rounded-[3px] bg-[#1A0D02]" />
                  Listening — tap to stop
                </>
              ) : (
                <>
                  <MicIcon />
                  {state === 'speaking' ? 'Tap to interrupt' : 'Tap to talk to ShopiQ'}
                </>
              )}
            </button>
          ) : (
            <p className="text-center text-[12px] leading-snug text-[#7E7E88]">
              {micReason}
            </p>
          )}

          {/* Typing is always available; nobody is forced to speak. */}
          <form onSubmit={submitTyped} className="flex items-center gap-2">
            <input
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              placeholder="or type what you need…"
              aria-label="Type your message to ShopiQ"
              maxLength={1000}
              disabled={busy}
              className="h-11 min-w-0 flex-1 rounded-full border border-white/9 bg-[#0C0C0F] px-4 text-[14px] text-white outline-none transition-colors placeholder:text-[#6E6E76] focus:border-[rgba(247,147,30,.5)] disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={busy || !typed.trim()}
              aria-label="Send"
              className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-white/12 text-[#C6C6CC] transition-colors hover:border-white/28 hover:text-white disabled:opacity-40"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 12h15M13 6l6 6-6 6" />
              </svg>
            </button>
          </form>
        </div>
      </div>

      <AgentShellStyles />
    </main>
  );
}

/* --------------------------------------------------------------- pieces */

function AgentProductRail({
  products,
  heading,
  onAdd,
}: {
  products: any[];
  heading?: string | null;
  onAdd?: (product: any) => void;
}) {
  return (
    <div className="-mx-6 px-6 pb-1">
      {heading ? (
        <p className="mb-2 text-[11px] uppercase tracking-wide text-[#7E7E88]">{heading}</p>
      ) : null}
      <ul className="flex gap-3 overflow-x-auto pb-1">
        {products.slice(0, 6).map((product, index) => (
          <li
            key={product.productId}
            // Staggered entrance, so cards arrive as a sequence rather than
            // appearing all at once — it reads as the agent presenting them.
            className="agent-card w-[168px] shrink-0 rounded-[16px] border border-white/8 bg-[#0C0C0F] p-3"
            style={{ animationDelay: `${Math.min(index, 5) * 70}ms` }}
          >
            <div className="relative mb-2.5 aspect-square overflow-hidden rounded-[11px] bg-[#101014]">
              {product.image ? (
                <Image src={product.image} alt="" fill sizes="168px" className="object-cover" />
              ) : null}
            </div>
            <p className="line-clamp-2 text-[12.5px] font-medium leading-snug text-white">
              {product.name}
            </p>
            <p className="mt-1 text-[14px] font-semibold text-white">{formatPrice(product.price)}</p>
            {product.keySpecs ? (
              <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-[#7E7E88]">
                {Object.values(product.keySpecs).slice(0, 2).join(' · ')}
              </p>
            ) : null}
            {product.available === false ? (
              <p className="mt-1.5 text-[11px] text-[#FF8B8B]">Out of stock</p>
            ) : onAdd ? (
              <button
                type="button"
                onClick={() => onAdd(product)}
                className="mt-2 h-8 w-full rounded-full border border-[rgba(247,147,30,.4)] bg-[rgba(247,147,30,.08)] text-[12px] font-medium text-[#F7931E] transition-colors hover:bg-[rgba(247,147,30,.16)]"
              >
                + Add
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function AgentComparison({ comparison }: { comparison: any }) {
  const products = comparison.products ?? [];
  const rows = comparison.rows ?? [];
  return (
    <div className="agent-rise overflow-x-auto rounded-[16px] border border-white/8 bg-[#0C0C0F] p-4">
      <table className="w-full min-w-[320px] text-left text-[12.5px]">
        <thead>
          <tr>
            <th className="pb-2 pr-3 font-normal text-[#7E7E88]" />
            {products.map((product: any) => (
              <th key={product.productId} className="pb-2 pr-3 font-medium text-white">
                {product.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 8).map((row: any) => (
            <tr key={row.label} className="border-t border-white/6">
              <td className="py-2 pr-3 text-[#7E7E88]">{row.label}</td>
              {(row.values ?? []).map((value: any, index: number) => (
                <td key={index} className="py-2 pr-3 text-[#EDEDF0]">
                  {String(value ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AgentCartStrip({ cart }: { cart: any }) {
  if (!cart?.items?.length) return null;
  return (
    <div className="agent-rise rounded-[16px] border border-white/8 bg-[#0C0C0F] p-4">
      <p className="mb-2.5 text-[11px] uppercase tracking-wide text-[#7E7E88]">Your cart</p>
      <ul className="space-y-1.5">
        {cart.items.slice(0, 4).map((item: any) => (
          <li key={item.cartItemId} className="flex items-baseline justify-between gap-3 text-[13px]">
            <span className="min-w-0 flex-1 truncate text-[#EDEDF0]">{item.name}</span>
            <span className="shrink-0 text-[#7E7E88]">×{item.quantity}</span>
            <span className="shrink-0 text-white">{formatPrice(item.lineTotal)}</span>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex items-baseline justify-between border-t border-white/7 pt-2.5">
        <span className="text-[12.5px] text-[#7E7E88]">Total</span>
        <span className="text-[16px] font-semibold text-white">{formatPrice(cart.total)}</span>
      </div>
    </div>
  );
}

/** Asks for whatever is still missing — one thing at a time, conversationally. */
/**
 * Links into the account pages, when a turn asks for something that lives
 * there.
 *
 * The agent screen is full-bleed with no navigation of its own, so an answer
 * like "add a delivery address and I'll pick straight back up" was a dead end:
 * the assistant emitted an `add_address` action and nothing rendered it. These
 * carry no id — the page resolves the customer from the session — so a link
 * can never be pointed at somebody else's data.
 */
const ACCOUNT_LINKS: Record<string, { href: string; label: string }> = {
  add_address: { href: '/account/addresses', label: 'Add a delivery address' },
  view_addresses: { href: '/account/addresses', label: 'My addresses' },
  view_profile: { href: '/account', label: 'My profile' },
  view_orders: { href: '/account/orders', label: 'My orders' },
};

function AgentAccountLinks({ actions }: { actions?: Array<{ type: string }> }) {
  const links = (actions ?? [])
    .map((action) => ACCOUNT_LINKS[action.type])
    .filter((link): link is { href: string; label: string } => Boolean(link));

  if (links.length === 0) return null;

  // De-duplicate: a turn may offer both "my addresses" and "add one".
  const seen = new Set<string>();
  const unique = links.filter((link) => !seen.has(link.href) && seen.add(link.href));

  return (
    <div className="flex flex-wrap justify-center gap-2">
      {unique.map((link) => (
        <a
          key={link.href}
          href={link.href}
          className="inline-flex h-10 items-center gap-2 rounded-full border border-[rgba(247,147,30,.45)] bg-[rgba(247,147,30,.08)] px-4 text-[13.5px] font-medium text-[#F7931E] transition-colors hover:border-[rgba(247,147,30,.85)]"
        >
          {link.label}
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 12h14M12 5l7 7-7 7" />
          </svg>
        </a>
      ))}
    </div>
  );
}

function AgentDetailPrompt({ agent, missing }: { agent: any; missing: string[] }) {
  const next = missing[0];
  const [value, setValue] = useState('');
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const labels: Record<string, { title: string; placeholder: string; type: string }> = {
    name: { title: "What's your full name?", placeholder: 'Yash Garg', type: 'text' },
    email: { title: 'What email should I send your invoice to?', placeholder: 'you@example.com', type: 'email' },
    phone: { title: 'What phone number should the delivery partner use?', placeholder: '98765 43210', type: 'tel' },
    address: { title: 'Where should I deliver your order?', placeholder: 'Flat, street, area', type: 'text' },
  };
  const field = labels[next] ?? labels.name;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!value.trim()) return;
    setPending(true);
    setNote(null);

    const patch =
      next === 'address'
        ? { address: { line1: value.trim(), city: 'Unknown', state: '', postalCode: '', country: 'India' } }
        : { [next === 'name' ? 'fullName' : next]: value.trim() };

    const result = await agent.collectDetail(patch);
    setPending(false);

    // The server validates every field; a rejection is surfaced rather than
    // silently accepted, because a misheard email cannot be undone later.
    if (result?.rejected?.length) {
      setNote(`That ${result.rejected[0]} didn't look right — could you repeat it?`);
      return;
    }
    setValue('');
  };

  return (
    <div className="agent-rise rounded-[16px] border border-[rgba(247,147,30,.28)] bg-[rgba(247,147,30,.05)] p-4">
      <p className="text-[14px] font-medium text-white">{field.title}</p>

      {next === 'address' ? (
        <button
          type="button"
          onClick={async () => {
            setPending(true);
            const result = await agent.useCurrentLocation();
            setPending(false);
            setNote(result.message);
          }}
          disabled={pending}
          className="mt-3 inline-flex h-9 items-center gap-2 rounded-full border border-white/12 px-3.5 text-[12.5px] text-[#EDEDF0] transition-colors hover:border-white/28 disabled:opacity-50"
        >
          Use my current location
        </button>
      ) : null}

      <form onSubmit={submit} className="mt-3 flex items-center gap-2">
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          type={field.type}
          placeholder={field.placeholder}
          aria-label={field.title}
          disabled={pending}
          className="h-10 min-w-0 flex-1 rounded-full border border-white/10 bg-[#101014] px-3.5 text-[13.5px] text-white outline-none placeholder:text-[#6E6E76] focus:border-[rgba(247,147,30,.5)] disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={pending || !value.trim()}
          className="h-10 shrink-0 rounded-full brand-gradient px-4 text-[13px] font-semibold text-[#1A0D02] disabled:opacity-40"
        >
          Save
        </button>
      </form>

      {note ? <p className="mt-2 text-[12px] text-[#C6C6CC]">{note}</p> : null}
      <p className="mt-2 text-[11.5px] text-[#7E7E88]">
        You can also just say it out loud — {missing.length} detail
        {missing.length === 1 ? '' : 's'} still needed.
      </p>
    </div>
  );
}

/**
 * The authoritative total, shown before payment.
 *
 * Voice-first does not mean the customer cannot SEE what they are about to pay.
 * Every figure here came from the server with the quote.
 */
function AgentQuoteCard({ agent, quote, busy }: { agent: any; quote: any; busy: boolean }) {
  return (
    <div className="agent-rise rounded-[16px] border border-white/10 bg-[#0C0C0F] p-4">
      <p className="mb-3 text-[11px] uppercase tracking-wide text-[#7E7E88]">Order summary</p>

      <ul className="space-y-1.5">
        {quote.items.map((item: any) => (
          <li key={item.product_id} className="flex items-baseline justify-between gap-3 text-[13px]">
            <span className="min-w-0 flex-1 truncate text-[#EDEDF0]">{item.name}</span>
            <span className="shrink-0 text-[#7E7E88]">×{item.quantity}</span>
            <span className="shrink-0 text-white">
              {formatPrice((item.unit_price_minor * item.quantity) / 100)}
            </span>
          </li>
        ))}
      </ul>

      <dl className="mt-3 space-y-1 border-t border-white/7 pt-2.5 text-[12.5px]">
        <div className="flex justify-between">
          <dt className="text-[#7E7E88]">Subtotal</dt>
          <dd className="text-[#EDEDF0]">{formatPrice(quote.subtotalMinor / 100)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-[#7E7E88]">Delivery</dt>
          <dd className="text-[#EDEDF0]">
            {quote.shippingMinor === 0 ? 'Free' : formatPrice(quote.shippingMinor / 100)}
          </dd>
        </div>
        <div className="flex justify-between pt-1.5">
          <dt className="text-[14px] font-medium text-white">Total</dt>
          <dd className="text-[18px] font-semibold text-white">{quote.amountDisplay}</dd>
        </div>
      </dl>

      <p className="mt-2.5 text-[11.5px] text-[#7E7E88]">
        Expected delivery {quote.deliveryEstimate}
        {quote.address?.line1 ? ` · ${quote.address.line1}, ${quote.address.city}` : ''}
      </p>

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={() => void agent.confirmAndPay()}
          disabled={busy}
          className="h-11 flex-1 rounded-full brand-gradient text-[14px] font-semibold text-[#1A0D02] disabled:opacity-50"
        >
          {busy ? 'Opening payment…' : 'Yes, proceed to payment'}
        </button>
      </div>

      <p className="mt-2 text-center text-[11px] text-[#6E6E76]">
        Payment is handled by Razorpay. ShopiQ never sees your card details.
      </p>
    </div>
  );
}

/**
 * Shell styling.
 *
 * `100dvh` rather than `100vh` so the layout does not sit under a mobile
 * browser's collapsing address bar, with a `vh` fallback for anything that
 * does not know `dvh`.
 */
function AgentShellStyles() {
  return (
    <style jsx global>{`
      .agent-card {
        animation: agent-card-in 0.42s cubic-bezier(0.22, 1, 0.36, 1) both;
      }
      @keyframes agent-card-in {
        from {
          opacity: 0;
          transform: translateY(12px) scale(0.97);
        }
        to {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
      }

      /* The comparison table and the summary cards use the same easing so the
         whole surface feels like one system rather than several. */
      .agent-rise {
        animation: agent-rise-in 0.36s cubic-bezier(0.22, 1, 0.36, 1) both;
      }
      @keyframes agent-rise-in {
        from {
          opacity: 0;
          transform: translateY(10px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .agent-card,
        .agent-rise {
          animation: none;
        }
      }

      .agent-dots {
        display: inline-flex;
        gap: 3px;
      }
      .agent-dots i {
        width: 5px;
        height: 5px;
        border-radius: 999px;
        background: #f7931e;
        animation: agent-dot 1s ease-in-out infinite;
      }
      .agent-dots i:nth-child(2) {
        animation-delay: 0.15s;
      }
      .agent-dots i:nth-child(3) {
        animation-delay: 0.3s;
      }
      @keyframes agent-dot {
        0%,
        100% {
          opacity: 0.25;
          transform: translateY(0);
        }
        50% {
          opacity: 1;
          transform: translateY(-3px);
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .agent-dots i {
          animation: none;
          opacity: 0.8;
        }
      }
      .agent-shell {
        min-height: 100vh;
        min-height: 100dvh;
        background:
          radial-gradient(120% 80% at 50% 108%, rgba(38, 33, 92, 0.5) 0%, rgba(0, 0, 0, 0) 62%),
          #000;
      }
    `}</style>
  );
}
