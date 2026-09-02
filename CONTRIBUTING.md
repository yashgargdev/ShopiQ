# Contributing to ShopiQ

Thanks for taking an interest. ShopiQ is an AI-native commerce platform — an
assistant that can search a catalogue, build a cart and take a payment. That
last part shapes everything about how it is built, and therefore how it should
be contributed to.

Please read [The rules that are not negotiable](#the-rules-that-are-not-negotiable)
before writing code that touches money, identity or the catalogue. Everything
else is ordinary.

---

## Table of contents

- [Getting set up](#getting-set-up)
- [Running it](#running-it)
- [The rules that are not negotiable](#the-rules-that-are-not-negotiable)
- [Project layout](#project-layout)
- [Testing](#testing)
- [Style](#style)
- [Commits and pull requests](#commits-and-pull-requests)
- [Reporting bugs](#reporting-bugs)
- [Security](#security)

---

## Getting set up

**Requirements**

| | |
|---|---|
| Node.js | 20 or newer (22 recommended) |
| npm | 10 or newer |
| A Supabase project | Postgres 17, free tier is fine |
| Playwright browsers | `npx playwright install chromium` — only for UI tests |

```bash
git clone https://github.com/yashgargdev/ShopiQ.git
cd ShopiQ
npm install
cp .env.example .env.local
```

Then fill in `.env.local`. Every variable is documented in
[`.env.example`](.env.example), and the README has a
[full reference](README.md#environment-variables).

**The minimum to boot** is a Supabase URL, its anon key and its service role
key. Without an AI key the assistant falls back to a deterministic provider, so
you can develop most of the app with no AI account at all. Without Razorpay
keys, run with `npm run dev:mock` and payments are simulated end to end.

**Never commit `.env.local`.** It is gitignored, and it must stay that way.
`.env.example` is the only environment file in version control, and it contains
placeholders only.

### Database

Migrations live in [`supabase/migrations/`](supabase/migrations) and are applied
in filename order. Apply them to a fresh Supabase project, then load the demo
catalogue:

```bash
npm run catalog:build      # regenerate data/catalog/catalog.json
npm run catalog:validate   # dry run — reports what WOULD change
npm run catalog:import     # write it to Supabase
```

The importer matches by SKU. Running it twice creates nothing and deletes
nothing; a product that disappears from the file is deactivated, never removed,
because orders reference products.

---

## Running it

```bash
npm run dev              # http://localhost:3000
npm run dev:mock         # with simulated payments
npm run dev:mock-https   # simulated payments over HTTPS, needed for some tests
```

---

## The rules that are not negotiable

ShopiQ hands a language model the ability to influence a purchase. The whole
architecture exists to make sure it cannot influence the parts that matter. If
a change would weaken any of these, it will not be merged — not because the
rule is sacred, but because the guarantee it protects is the product.

### 1. The model never decides money

The LLM converts language into structured intent, and turns settled facts into
sentences. That is all. It must never be the source of:

> price · discount · tax · shipping · total · stock · order status ·
> payment status · customer identity

All of those are read from the database or computed by the server. If you find
yourself parsing a number out of a model response and using it, stop — that is
the bug this rule exists to prevent.

### 2. Money is integer paise

Never store or transmit a monetary amount as a float. Rounding a rupee into
existence is trivially easy and very hard to notice.

### 3. The customer authorises the exact amount

A payment requires an explicit confirmation of a specific figure, and that
figure is re-checked server-side before anything is charged. The AI may
*request* a money action; only the backend may *authorise* one.

### 4. Identity comes from the session, never from the conversation

A shopper's account is resolved from their signed-in session. An email address
or an order number typed into the chat grants nothing. Any handler that reads
customer data must derive the customer id from the session — never from a tool
argument.

### 5. Secrets stay on the server

`SUPABASE_SERVICE_ROLE_KEY`, `RAZORPAY_KEY_SECRET`, `SARVAM_API_KEY`,
`ANTHROPIC_API_KEY` and the SMTP credentials must never reach the browser. Only
`NEXT_PUBLIC_*` variables may be referenced from a client component. Files that
must stay server-side start with `import 'server-only'` — keep it there.

### 6. An honest "no" beats a plausible answer

If the catalogue has nothing that matches, say so. Do not widen the search
silently, substitute a near miss, or fill an unknown rating with a guess. A
recommender that always returns something looks good in a demo and is wrong in
exactly the situations that cost a customer money.

### 7. Destructive actions are confirmed

Clearing a cart, cancelling an order, deleting an address: ask first, and treat
an ambiguous reply as "no".

`npm run test:security` asserts most of the above. It is not optional.

---

## Project layout

```
app/                  Next.js App Router. (storefront) is the shop,
                      merchant/ is the seller panel, api/ the routes.
components/           React components, grouped by surface.
lib/
  ai/                 The agent: routing, tools, references, language.
  catalog/            Retrieval, compatibility, ranking, recommendation.
  payments/           Razorpay, the mock provider, verification.
  checkout/           Preparing and confirming an order.
  products/ cart/ orders/ reviews/    Data access.
data/catalog/         Taxonomy, vocabulary, rules, ranking, demo dataset.
supabase/migrations/  Schema, applied in filename order.
scripts/              Every test suite, plus seeding and catalogue tooling.
docs/                 Architecture, security and evaluation notes.
```

A few conventions worth knowing:

- **`proxy.ts`, not `middleware.ts`.** This is Next.js 16; read
  `node_modules/next/dist/docs/` before assuming an API still exists.
- **The AI never queries the database directly.** It calls tools in
  `lib/ai/tools/`, which are validated, budgeted, logged and idempotent.
- **Recommendation logic lives in `data/catalog/*.json`,** not in code. Adding a
  rule is editing JSON; the engine reads it.

---

## Testing

There is no test runner and no framework — each suite is a plain Node script
that prints PASS/FAIL and exits non-zero on failure.

**Suites that need nothing but Node** (safe to run anywhere, and what CI runs):

```bash
npm run typecheck
npm run test:ai-unit
npm run test:cart-unit
npm run test:payment-unit
npm run test:voice-unit
npm run test:catalog
```

**Suites that need a running dev server and a database:**

```bash
npm run dev            # in one terminal
npm run test:all       # in another
```

Some notes that will save you time:

- `test:payment-flows` and `test:payment-ui` need the **mock** payment provider
  (`npm run dev:mock-https`). Against real Razorpay keys they skip, because
  completing a payment in a browser needs a human.
- UI suites drive a real browser. Run `npx playwright install chromium` first.
- Running several suites at once against one dev server can trip rate limits and
  produce failures that vanish on a rerun. If a suite fails, **run it alone
  before believing it.**

**When a test fails, work out which of these it is** before changing anything:

1. A real regression — fix the code.
2. A stale assertion that encoded an assumption which is no longer true — fix
   the test, and say in the diff why the old expectation was wrong.
3. Flakiness — fix the flake. Raising a timeout is almost never the answer; the
   two "slow server" failures in this repo's history were both a waiter armed
   after the event it was waiting for.

Never make a test pass by weakening what it asserts.

---

## Style

- **TypeScript everywhere**, strict. `npm run typecheck` must pass.
- **Comments explain *why*, not *what*.** The code already says what it does.
  A comment earns its place by recording the reason a thing is the way it is —
  especially the non-obvious constraint or the bug that shaped it.
- **Match the surrounding code.** Naming, density, idiom.
- **Tailwind for styling.** Careful with `space-y-*` on children that carry
  `m-0`: both set margin, and stylesheet order decides the winner. Use flex
  `gap` when the children reset their own margins.
- `npm run lint` currently reports pre-existing errors, mostly
  `@typescript-eslint/no-explicit-any` in older modules. **Do not add new
  ones**, and fixing the ones you touch is welcome.

---

## Commits and pull requests

**Commit messages** should say what changed and why it needed to. The bar is
that someone reading `git log` in a year understands the reasoning without
opening the diff. Explain the cause, not just the symptom.

```
Stop the mobile header drawing on top of itself

Neither flex group could shrink — no min-w-0 on the brand, no shrink-0 on
the controls — so instead of compressing, the row overflowed and the two
drew over each other.
```

**Before opening a pull request:**

```bash
npm run typecheck
npm run build
npm run test:catalog && npm run test:ai-unit && npm run test:cart-unit
```

Then fill in the [pull request template](.github/PULL_REQUEST_TEMPLATE.md). It
asks how you tested the change — please answer that honestly, including what you
did *not* test. "I did not run the payment suites" is useful information; a
blank checkbox that implies you did is not.

Keep pull requests focused. One change per PR makes review possible and revert
cheap.

---

## Reporting bugs

Open an issue using the bug template. The single most useful thing you can
include is **what you said to the assistant and what it said back** — this is a
conversational app, and the exact wording usually is the bug.

---

## Security

**Do not open a public issue for a security vulnerability.** See
[SECURITY.md](SECURITY.md) for how to report one privately.

---

## Licence

By contributing, you agree that your contributions will be licensed under the
[MIT Licence](LICENSE) that covers this project.
