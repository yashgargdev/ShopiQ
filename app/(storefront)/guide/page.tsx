import type { Metadata } from 'next';
import Link from 'next/link';
import Image from 'next/image';
import type { ReactNode } from 'react';

import { SparkIcon } from '@/components/ui/icons';
import { LinkButton } from '@/components/ui/primitives';

export const metadata: Metadata = {
  title: 'How ShopiQ works',
  description:
    'A guide to shopping by conversation: how ShopiQ finds things, why it recommends what it does, how to place an order, and how to manage one afterwards.',
};

/**
 * The guide.
 *
 * Written for someone who has never talked to a shop before. Agentic shopping
 * is unfamiliar enough that the honest thing is to show it rather than describe
 * it, so every screenshot here is a real capture of the running app, taken by
 * scripts/capture-guide-shots.mjs — re-run it when the interface moves, because
 * a guide that shows something the product no longer looks like is worse than
 * one with no pictures at all.
 */

/* ------------------------------------------------------------------ pieces */

function Shot({
  src,
  alt,
  caption,
  width,
  height,
  phone = false,
}: {
  src: string;
  alt: string;
  caption: string;
  width: number;
  height: number;
  phone?: boolean;
}) {
  return (
    <figure className="m-0">
      <div
        className={
          phone
            ? 'mx-auto max-w-[260px] overflow-hidden rounded-[18px] border border-white/10 bg-black'
            : 'overflow-hidden rounded-[14px] border border-white/10 bg-black'
        }
      >
        <Image
          src={src}
          alt={alt}
          width={width}
          height={height}
          className="h-auto w-full"
          sizes="(max-width: 768px) 100vw, 720px"
        />
      </div>
      <figcaption className="mt-2.5 text-[12.5px] leading-relaxed text-[#7E7E88]">
        {caption}
      </figcaption>
    </figure>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className="relative pl-11">
      <span
        aria-hidden
        className="absolute left-0 top-0 grid h-[30px] w-[30px] place-items-center rounded-full brand-gradient text-[13px] font-semibold text-[#1A0D02]"
      >
        {n}
      </span>
      <h3 className="m-0 pt-[3px] text-[16.5px] font-semibold tracking-[-0.01em] text-white">
        {title}
      </h3>
      <div className="mt-2 flex flex-col gap-3 text-[14.5px] leading-[1.65] text-[#B4B4BE]">{children}</div>
    </li>
  );
}

function Section({
  id,
  eyebrow,
  title,
  children,
}: {
  id: string;
  eyebrow: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 border-t border-white/8 pt-12">
      <p className="m-0 text-[11.5px] font-semibold uppercase tracking-[0.14em] text-[#F7931E]">
        {eyebrow}
      </p>
      <h2 className="m-0 mt-2.5 text-[24px] font-semibold tracking-[-0.02em] text-white md:text-[30px]">
        {title}
      </h2>
      <div className="mt-6">{children}</div>
    </section>
  );
}

function Say({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-[7px] border border-white/10 bg-white/[0.045] px-1.5 py-[3px] font-mono text-[13px] text-[#EDEDF0]">
      “{children}”
    </span>
  );
}

const CONTENTS = [
  ['what', 'What ShopiQ is'],
  ['talking', 'Talking to it'],
  ['finding', 'Finding something'],
  ['why', 'Why it suggests what it does'],
  ['cart', 'Your cart'],
  ['order', 'Placing an order'],
  ['manage', 'Managing an order'],
  ['limits', 'What it will not do'],
  ['phone', 'On a phone'],
] as const;

/* -------------------------------------------------------------------- page */

export default function GuidePage() {
  return (
    <main className="mx-auto max-w-[1320px] px-5 pb-[110px] pt-11 md:px-8">
      {/* ------------------------------------------------------------ hero */}
      <header className="max-w-[720px]">
        <span className="inline-flex items-center gap-2 rounded-full border border-[rgba(247,147,30,.32)] bg-[rgba(247,147,30,.09)] px-3 py-1.5 text-[12px] font-medium text-[#FFC07A]">
          <SparkIcon size={13} />
          Guide
        </span>
        <h1 className="m-0 mt-5 text-[32px] font-semibold leading-[1.1] tracking-[-0.03em] text-white md:text-[46px]">
          How ShopiQ works
        </h1>
        <p className="mt-4 text-[16px] leading-[1.7] text-[#B4B4BE] md:text-[17.5px]">
          Most online shops give you a search box and a wall of filters, and leave the
          judgement to you. ShopiQ is built the other way round: you say what you need in
          your own words, and it does the narrowing, the comparing and the checking out —
          showing its reasoning at every step, and asking before it spends your money.
        </p>
      </header>

      {/* --------------------------------------------------------- contents */}
      <nav
        aria-label="On this page"
        className="mt-10 rounded-[14px] border border-white/9 bg-[#0C0C0E] p-5"
      >
        <p className="m-0 mb-3 text-[11.5px] font-semibold uppercase tracking-[0.14em] text-[#6E6E76]">
          On this page
        </p>
        <ol className="m-0 grid list-none grid-cols-1 gap-x-8 gap-y-2 p-0 sm:grid-cols-2 lg:grid-cols-3">
          {CONTENTS.map(([id, label], index) => (
            <li key={id}>
              <a
                href={`#${id}`}
                className="flex items-baseline gap-2.5 text-[14px] text-[#B4B4BE] transition-colors hover:text-white"
              >
                <span className="font-mono text-[12px] text-[#6E6E76]">
                  {String(index + 1).padStart(2, '0')}
                </span>
                {label}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      <div className="mt-14 space-y-14">
        {/* ============================================================ what */}
        <Section id="what" eyebrow="The idea" title="Shopping by conversation">
          <div className="grid gap-8 lg:grid-cols-[1.05fr_1fr] lg:items-start">
            <div className="flex flex-col gap-4 text-[14.5px] leading-[1.7] text-[#B4B4BE]">
              <p className="m-0">
                ShopiQ&apos;s front door is not a product grid. It is something that
                listens. You arrive, say what you are after, and it goes and looks —
                the same way you would ask a person behind a counter.
              </p>
              <p className="m-0">
                The important part is what happens underneath. The AI reads your words
                and writes the replies, but it never decides what you are shown.
                Searching, filtering, ranking, pricing and stock are all settled by
                ShopiQ against the live catalogue, and the AI is handed the finished
                list to explain. That is why it can tell you honestly that it has
                nothing for you instead of offering the nearest thing and hoping.
              </p>
              <p className="m-0">
                The catalogue is still there if you would rather browse.{' '}
                <Link href="/products" className="text-[#FFC07A] underline-offset-2 hover:underline">
                  The store
                </Link>{' '}
                works exactly as you expect, and the assistant is one tap away on every
                page.
              </p>
            </div>
            <Shot
              src="/guide/landing.png"
              alt="The ShopiQ home screen: a single prompt reading “What are you looking for?”, with a microphone button and a text box."
              width={1440}
              height={900}
              caption="The front door. Tap the microphone and talk, or type — the suggestions underneath are there to show the kind of thing it understands."
            />
          </div>
        </Section>

        {/* ========================================================= talking */}
        <Section id="talking" eyebrow="Step one" title="Talking to it">
          <div className="grid gap-5 sm:grid-cols-3">
            {[
              {
                title: 'Voice or text',
                body: 'Tap “Tap to talk to ShopiQ” and speak, or type in the box below it. Both go to the same place, and you can switch mid-conversation.',
              },
              {
                title: 'English, Hindi or Hinglish',
                body: 'Ask in Hindi and it answers in Hindi. “Mujhe 50 hazaar ke andar laptop chahiye” works exactly as well as the English version.',
              },
              {
                title: 'It remembers',
                body: 'You can say “the second one”, “the cheaper one”, or “add that charger” and it knows what you mean from what it just showed you.',
              },
            ].map((card) => (
              <div
                key={card.title}
                className="rounded-[14px] border border-white/9 bg-[#0C0C0E] p-5"
              >
                <h3 className="m-0 text-[15px] font-semibold text-white">{card.title}</h3>
                <p className="m-0 mt-2 text-[14px] leading-[1.65] text-[#96969F]">{card.body}</p>
              </div>
            ))}
          </div>

          <p className="mt-6 text-[14.5px] leading-[1.7] text-[#B4B4BE]">
            Say as much or as little as you like. <Say>a laptop</Say> is enough to start —
            it will ask what you will use it for and roughly what you want to spend.{' '}
            <Say>a laptop for programming and gaming under ₹80,000</Say> gets you straight
            to a shortlist.
          </p>
        </Section>

        {/* ========================================================= finding */}
        <Section id="finding" eyebrow="Step two" title="Finding something">
          <div className="grid gap-8 lg:grid-cols-[1fr_420px] lg:items-start">
            <ol className="m-0 flex list-none flex-col gap-8 p-0">
              <Step n={1} title="Say what it is for, not what it is called">
                <p className="m-0">
                  You do not need to know the model. Describe the job — editing video,
                  a first phone for a parent, something for a long flight — and the
                  requirements are worked out from that.
                </p>
              </Step>
              <Step n={2} title="Every result says why it is there">
                <p className="m-0">
                  Each card carries the reasons it matched: how it sits against your
                  budget, which specifications answered your requirements, and anything
                  worth knowing before you buy. A drawback stated plainly is more useful
                  than a product oversold.
                </p>
              </Step>
              <Step n={3} title="Narrow it by saying so">
                <p className="m-0">
                  <Say>cheaper</Say>, <Say>something lighter</Say>,{' '}
                  <Say>only Samsung</Say>, <Say>compare the top two</Say>. Each one
                  refines the search you already have rather than starting a new one.
                </p>
              </Step>
              <Step n={4} title="An honest “no”">
                <p className="m-0">
                  Ask for a gaming laptop under ₹20,000 and it will tell you there
                  isn&apos;t one, rather than showing you a ₹60,000 machine and letting
                  you notice the price yourself.
                </p>
              </Step>
            </ol>
            <Shot
              src="/guide/panel-results.png"
              alt="The ShopiQ assistant panel listing three laptops. Each card shows the price, the discount, stock, and bullet points explaining why it matched, with Add to Cart and View product buttons."
              width={420}
              height={800}
              caption="Results inside the assistant panel. The bullets under each price are the actual reasons it was ranked where it was."
            />
          </div>
        </Section>

        {/* ============================================================= why */}
        <Section id="why" eyebrow="Step three" title="Why it suggests what it does">
          <div className="grid gap-8 lg:grid-cols-[1fr_420px] lg:items-start">
            <div className="flex flex-col gap-4 text-[14.5px] leading-[1.7] text-[#B4B4BE]">
              <p className="m-0">
                Add something and ShopiQ will offer what genuinely goes with it — a case
                that fits <em>your</em> phone, a sleeve sized for <em>your</em> laptop, a
                television the console can actually drive. Compatibility is checked
                against the catalogue, so an accessory made for another brand is never
                offered, even when it would otherwise rank well.
              </p>
              <p className="m-0">
                If you want to know why, ask: <Say>why did you recommend that?</Say> The
                answer comes from the reasons recorded when the choice was made — not from
                the assistant reconstructing a justification afterwards. If the reasoning
                does not match what you care about, say so and it will look again.
              </p>
              <p className="m-0">
                Anything already in your cart is never suggested again, and every
                suggestion has an <strong className="font-semibold text-white">Add to Cart</strong>{' '}
                button, so accepting one is a single tap.
              </p>
            </div>
            <Shot
              src="/guide/panel-why.png"
              alt="The assistant explaining a recommendation: “I suggested the ShopiQ Laptop Sleeve 15 inch at ₹1,699 for 3 reasons — protects the laptop when you carry it; fits a 15.6 inch device; a small addition next to the main purchase.”"
              width={420}
              height={800}
              caption="Asked why, it gives the real reasons — including the compatibility fact that a 15.6-inch laptop needs the 15-inch sleeve."
            />
          </div>
        </Section>

        {/* ============================================================ cart */}
        <Section id="cart" eyebrow="Step four" title="Your cart">
          <div className="grid gap-8 lg:grid-cols-[420px_1fr] lg:items-start">
            <Shot
              src="/guide/panel-added.png"
              alt="The assistant confirming an item was added, showing a cart card with the item, subtotal, savings, delivery and total."
              width={420}
              height={800}
              caption="Every change shows the cart back to you, priced by ShopiQ rather than by the AI."
            />
            <div className="flex flex-col gap-4 text-[14.5px] leading-[1.7] text-[#B4B4BE]">
              <p className="m-0">
                The assistant&apos;s cart and the website&apos;s cart are the same cart.
                Add something by talking, and it is there on{' '}
                <Link href="/cart" className="text-[#FFC07A] underline-offset-2 hover:underline">
                  the cart page
                </Link>{' '}
                and in the header count.
              </p>
              <ul className="m-0 flex flex-col gap-2 pl-5 text-[14.5px]">
                <li>
                  <Say>make it two</Say> or <Say>remove the sleeve</Say> — quantities and
                  removals by conversation.
                </li>
                <li>
                  <Say>what&apos;s my total?</Say> — the itemised total, including
                  delivery.
                </li>
                <li>
                  <Say>clear my cart</Say> — asked to confirm first, because it cannot be
                  undone.
                </li>
              </ul>
              <p className="m-0">
                If a product goes out of stock or changes price while it is sitting in
                your cart, you are told before checkout rather than at it.
              </p>
            </div>
          </div>
        </Section>

        {/* =========================================================== order */}
        <Section id="order" eyebrow="Step five" title="Placing an order">
          <p className="mb-8 max-w-[760px] text-[14.5px] leading-[1.7] text-[#B4B4BE]">
            Say <Say>I&apos;m ready to buy</Say> and ShopiQ walks the rest. Nothing is
            charged until you approve an exact figure, and the figure you approve is the
            figure that is charged.
          </p>

          <ol className="m-0 grid list-none gap-8 p-0 lg:grid-cols-2">
            <Step n={1} title="It signs you in first">
              <p className="m-0">
                If you are not signed in, it asks for your email and sends a six-digit
                code — no password to remember. This happens{' '}
                <em>before</em> payment so the order has an owner from the moment it
                exists, and you can find it again afterwards.
              </p>
            </Step>
            <Step n={2} title="It confirms where it is going">
              <p className="m-0">
                Your saved addresses are listed to choose from, or you can add a new one.
                Nothing is quoted until it knows where it ships — an order that is paid
                for and going nowhere helps nobody.
              </p>
            </Step>
            <Step n={3} title="You approve an exact total">
              <p className="m-0">
                A checkout card appears with the items, the delivery charge and the
                total. That amount is what gets sent to the payment provider. The AI
                cannot alter it — it is calculated and held by ShopiQ.
              </p>
            </Step>
            <Step n={4} title="You pay through Razorpay">
              <p className="m-0">
                Card details are entered in Razorpay&apos;s own window. ShopiQ never sees
                your card number, and the payment is verified on the server before an
                order is created. If a payment fails you can retry — a successful retry
                still produces exactly one order.
              </p>
            </Step>
          </ol>

          <div className="mt-8 rounded-[14px] border border-[rgba(247,147,30,.28)] bg-[rgba(247,147,30,.06)] p-5">
            <p className="m-0 text-[14.5px] leading-[1.7] text-[#E8D8C4]">
              <strong className="font-semibold text-white">Your order number.</strong>{' '}
              Confirmed orders get a short reference like{' '}
              <span className="font-mono text-[#FFC07A]">#2609010</span> — the year, the
              month, and its place in that month. Short enough to read out over the phone,
              and enough for ShopiQ to find the order.
            </p>
          </div>
        </Section>

        {/* ========================================================== manage */}
        <Section id="manage" eyebrow="Afterwards" title="Managing an order">
          <div className="grid gap-8 lg:grid-cols-[1fr_1fr] lg:items-start">
            <div className="flex flex-col gap-4 text-[14.5px] leading-[1.7] text-[#B4B4BE]">
              <p className="m-0">
                You never have to hunt for an order form. Ask, and ShopiQ answers about
                your own orders — it can only ever see yours, because it reads your
                account from your signed-in session rather than from anything you type.
              </p>
              <ul className="m-0 flex flex-col gap-2 pl-5">
                <li>
                  <Say>what did I order?</Say> — your recent orders, itemised.
                </li>
                <li>
                  <Say>where is my order?</Say> — status and payment state.
                </li>
                <li>
                  <Say>cancel my order</Say> — if more than one could be meant, it asks
                  which, and remembers the answer.
                </li>
                <li>
                  <Say>I want to return this</Say> — starts a return or replacement
                  request.
                </li>
              </ul>
              <p className="m-0">
                It works the other way too. Everything the assistant can do is on the
                account pages as a form and a list, because dictating a PIN code is worse
                than typing it.
              </p>
              <div className="flex flex-wrap gap-2.5 pt-1">
                <LinkButton href="/account/orders" variant="ghost">
                  My orders
                </LinkButton>
                <LinkButton href="/account/addresses" variant="ghost">
                  Addresses
                </LinkButton>
              </div>
            </div>
            <div className="flex flex-col gap-6">
              <Shot
                src="/guide/orders.png"
                alt="The My orders page showing order #2609010, its status timeline from Confirmed to Delivered, the item, the total, and a Cancel order button."
                width={1440}
                height={900}
                caption="The orders page: status, contents and a cancel button."
              />
              <Shot
                src="/guide/panel-order-status.png"
                alt="The assistant answering “what did I order?” with the order number, status, item and total."
                width={420}
                height={800}
                caption="The same information, asked for in words."
              />
            </div>
          </div>
        </Section>

        {/* ========================================================== limits */}
        <Section id="limits" eyebrow="Worth knowing" title="What it will not do">
          <p className="mb-6 max-w-[760px] text-[14.5px] leading-[1.7] text-[#B4B4BE]">
            An assistant that can spend your money has to be built so that it
            can&apos;t do so on its own. These are guarantees enforced by the system,
            not instructions the AI is asked to follow.
          </p>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {[
              {
                title: 'It never sets a price',
                body: 'Prices, discounts, delivery and totals are read from the catalogue and calculated by ShopiQ. The AI is told the numbers; it cannot change them.',
              },
              {
                title: 'It never charges you unasked',
                body: 'Payment needs your explicit approval of an exact amount, and that approval is checked again on the server before anything is taken.',
              },
              {
                title: 'It never invents a product',
                body: 'It can only show what is in the catalogue. Ask for something not stocked and it says so plainly.',
              },
              {
                title: 'It only sees your account',
                body: 'Your identity comes from your signed-in session. Naming someone else’s email or order number does not grant access to it.',
              },
              {
                title: 'It confirms before destroying',
                body: 'Clearing a cart or cancelling an order is asked about first, and a vague answer is treated as “no”.',
              },
              {
                title: 'It admits what it does not know',
                body: 'If a rating, a specification or a stock figure is not recorded, it tells you that instead of filling the gap.',
              },
            ].map((card) => (
              <div
                key={card.title}
                className="rounded-[14px] border border-white/9 bg-[#0C0C0E] p-5"
              >
                <h3 className="m-0 text-[15px] font-semibold text-white">{card.title}</h3>
                <p className="m-0 mt-2 text-[14px] leading-[1.65] text-[#96969F]">{card.body}</p>
              </div>
            ))}
          </div>
        </Section>

        {/* =========================================================== phone */}
        <Section id="phone" eyebrow="Anywhere" title="On a phone">
          <div className="grid gap-8 lg:grid-cols-[1fr_auto] lg:items-center">
            <div className="flex flex-col gap-4 text-[14.5px] leading-[1.7] text-[#B4B4BE]">
              <p className="m-0">
                ShopiQ is built for a phone first — which is where talking to a shop makes
                the most sense. The assistant fills the screen, the microphone is under
                your thumb, and the bottom bar carries the same entry point the desktop
                header does.
              </p>
              <p className="m-0">
                Everything in this guide works identically on both. The conversation
                follows your account, so you can start on a laptop and finish on a phone
                with the cart intact.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-5 lg:w-[420px]">
              <Shot
                phone
                src="/guide/mobile-landing.png"
                alt="ShopiQ on a phone: the assistant home screen with the talk button at the bottom."
                width={390}
                height={844}
                caption="The assistant."
              />
              <Shot
                phone
                src="/guide/mobile-store.png"
                alt="The ShopiQ store on a phone, showing the product grid and the bottom navigation bar."
                width={390}
                height={844}
                caption="The store."
              />
            </div>
          </div>
        </Section>
      </div>

      {/* ------------------------------------------------------------- close */}
      <section className="mt-16 rounded-[18px] border border-white/10 bg-[#0C0C0E] p-8 text-center md:p-12">
        <h2 className="m-0 text-[22px] font-semibold tracking-[-0.02em] text-white md:text-[28px]">
          Try it with something you actually need
        </h2>
        <p className="mx-auto mt-3 max-w-[540px] text-[14.5px] leading-[1.7] text-[#96969F]">
          It works best when you talk to it the way you would talk to a person — the
          budget, the use, and the thing you are worried about getting wrong.
        </p>
        <div className="mt-7 flex flex-wrap justify-center gap-3">
          <LinkButton href="/">Ask ShopiQ</LinkButton>
          <LinkButton href="/products" variant="ghost">
            Browse the store
          </LinkButton>
        </div>
      </section>
    </main>
  );
}
