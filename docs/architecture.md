# ShopiQ — Architecture

ShopiQ is an AI commerce agent. A customer describes what they need, in English
or Hinglish, by typing or by speaking; ShopiQ finds real products, compares
them, builds the cart, and takes payment through Razorpay — with the customer
authorising every rupee.

This document describes how it is put together and, more importantly, **why the
parts are separated the way they are**. Most of the design follows from one
decision made in Phase 2 and never relaxed since.

---

## The deterministic core

**The model never picks, ranks, or prices a product.**

The LLM does exactly two jobs:

1. turn a sentence into a structured requirement object, and
2. write prose about a result that was already decided.

Everything between those two steps — filtering, scoring, ranking, stock checks,
totals, tax, shipping — is ordinary TypeScript and SQL. This is why ShopiQ can
claim it does not hallucinate commerce facts: not because the prompt asks
nicely, but because there is no code path in which a model-produced number
becomes a price, a stock level or a charge.

```
                         SHOPIQ
                            │
                  ┌─────────┴─────────┐
                TEXT                VOICE
                  │                   │
                  │                SARVAM
                  │              STT  ·  TTS
                  └─────────┬─────────┘
                            ▼
                    SHOPIQ AI AGENT           ← extraction + prose only
                            │
                      TOOL REGISTRY           ← allowlist + Zod + permissions
                            │
       ┌────────────────────┼────────────────────┐
       ▼                    ▼                    ▼
    PRODUCTS              CART               CHECKOUT
       │                    │                    │
       └────────────────────┼────────────────────┘
                            ▼
                       VALIDATION               ← price · stock · identity
                            ▼
                 EXPLICIT CONFIRMATION          ← a row, not a phrase
                            ▼
                    RAZORPAY (test)
                            ▼
                SERVER-SIDE VERIFICATION        ← signature + provider re-read
                            ▼
                          ORDER
                            ▼
                   INVENTORY FINALIZE
                            ▼
                       AUDIT TRAIL
                            │
                ┌───────────┴───────────┐
                ▼                       ▼
            CUSTOMER               MERCHANT
           EXPERIENCE              INSIGHTS
```

---

## Layers

### Frontend — Next.js 16 App Router

Two route groups, so the merchant panel does not wear a shopper's cart badge:

| Group | Owns |
| --- | --- |
| `app/(storefront)/` | Home, catalogue, search, PDP, cart, checkout, orders, account, `/demo` |
| `app/merchant/(dashboard)/` | Products, inventory, orders, analytics, AI Insights, Audit |

`app/layout.tsx` carries only `<html>` and `<body>`; each half supplies its own
frame. `proxy.ts` (Next 16's replacement for `middleware.ts`) refreshes the
session and gates merchant routes.

### AI agent — `lib/ai/`

| Module | Responsibility |
| --- | --- |
| `provider/` | The `AIProvider` interface, Anthropic and Sarvam implementations, and a deterministic fallback |
| `requirements/` | `rules.ts` (regex, authoritative) merged with `extract.ts` (model, advisory) |
| `recommend/engine.ts` | Hard-constraint filtering then weighted scoring. No model involved |
| `references.ts` | "the second one", "the cheaper one", `#2`, `pehla wala` → a product id |
| `crosssell.ts` | Deterministic accessory pairing with five-dimension ranking |
| `confirm.ts` | Pending actions: eight states, frozen arguments, TTL |
| `cart-actions.ts` / `purchase-actions.ts` | Turn handlers for cart and money |
| `tools/registry.ts` | The allowlist. Every tool call in ShopiQ goes through it |
| `response-type.ts` | Server-derived response type and the spoken summary |

**The rules beat the model.** Where the deterministic extractor is confident, it
overrides whatever the model said. A regex cannot invent a budget that is not in
the text; a model can.

### Tool registry — the only way the AI reaches anything

Sixteen tools on four permission rungs:

| Level | Risk | Tools |
| --- | --- | --- |
| 1 | low | `search_products` `get_product` `compare_products` `check_inventory` `get_categories` `get_related_products` `get_cart` |
| 2 | medium | `add_to_cart` `remove_from_cart` `update_cart_quantity` `clear_cart` |
| 3 | medium | `prepare_checkout` `get_checkout_confirmation` |
| 4 | critical | `create_payment` `get_payment_status` `get_order_status` |

A call runs only if the name is on the allowlist **and** the arguments parse
against that tool's Zod schema. Everything else is rejected and logged. The
same Zod schemas generate the JSON Schema the model sees, so its view and the
enforcement cannot drift apart.

**No tool anywhere accepts a price, a total, a `customer_id` or a `cart_id`.**
Identity comes from the session; money comes from the catalogue.

### Voice — `lib/voice/`

Voice is an *interface*, not a second agent. Speech-to-text produces the same
string the text box produces, and nothing downstream branches on which was
used — `input_mode` is a label on the conversation row.

The browser encodes 16-bit PCM WAV directly rather than using MediaRecorder's
WebM/Opus, so there is one known format everywhere and no server-side
transcoding. Audio is held for one request and dropped: no file, no database
row, and the response says `audio_retained: false`.

### Commerce — `lib/cart/`, `lib/checkout/`, `lib/orders/`

One cart. The website and the assistant call the same service, which calls the
same `SECURITY DEFINER` functions. Cart writes take a row lock on `inventory`,
so check-then-write is a single locked transaction and two concurrent adds of
the last unit cannot both succeed.

### Payments — `lib/payments/`

Nothing outside this directory knows Razorpay exists.

```
authorize → provider order → (browser pays) → verify server-side →
finalize in one transaction → audit → attribute
```

`authorizePayment()` is the Level 4 gate: seventeen conditions, re-checked
against the live database at the moment of asking. Amounts are integer paise
computed from decimal strings — `79.99 * 100` is `7998.9999999999991` in
IEEE-754, which is not a property to rely on when the number is a charge.

### Data — Supabase PostgreSQL

Ten migrations. RLS on everything; the audit and analytics tables have RLS
enabled with **no policy at all**, so no browser role can read them.

| Migration | Adds |
| --- | --- |
| 0001–0004 | Schema, RLS, functions, function privileges |
| 0005 | Conversations, messages, tool logs |
| 0006 | Typed spec filters in search |
| 0007 | Agentic cart: `price_at_add`, pending actions, idempotency keys, locked cart RPCs |
| 0008 | Image attribution |
| 0009 | Payments, purchase confirmations, payment events, webhook de-duplication |
| 0010 | AI recommendations, commerce events, AI usage, attribution and insight functions |

Mutating functions are granted to `service_role` alone — and revoked from
`anon` and `authenticated` **by name**, because `REVOKE … FROM public` does not
remove Supabase's standing grants. That lesson cost a real security hole in
Phase 1; migration `0004` documents it.

### Storage — Cloudflare R2

Product images behind a CDN. Uploads are validated by magic bytes with a 5 MB
cap and sanitised keys. 23 products carry real photography with
author/licence/source recorded; the rest keep a generated placeholder, because a
confidently wrong product photo is worse than a neutral one.

### Analytics — `lib/analytics/`

Attribution is **recorded, never inferred**. A row is written the moment the
assistant shows a product and updated as the customer clicks, adds and pays.
Revenue is attributed once per order line, preferring a cross-sell over a
search impression, so cross-sell revenue and AI-assisted revenue never
double-count the same rupee.

Rates are returned as numerator/denominator pairs so the UI can render **N/A**
on an empty denominator. A 0% conversion rate computed from zero sessions is a
fact about missing data, not about the product.

---

## Request paths

**A shopping turn**

```
POST /api/ai/chat
  → rate limit (session + IP), size cap, conversation ownership
  → extraction: rules ∪ model, rules win
  → agent → tool registry → commerce services → Supabase
  → engine filters and scores          ← no model
  → model writes prose about the result
  → persist turn + record impressions
  → { message, products, decision{…}, speech }
```

**A payment**

```
POST /api/payments/create
  → authorizePayment(): 17 checks against live data
  → provider order (amount derived server-side)
  → browser completes Razorpay Checkout
POST /api/payments/verify
  → HMAC signature + provider re-read + amount match
  → finalize_paid_payment(): order + stock + confirmation + cart, one transaction
  → audit + attribution
```

A webhook is the same finalization by a second path, de-duplicated on a unique
index so two copies of one event cannot both proceed.

---

## What is deliberately absent

- No autonomous purchasing. Every charge needs a fresh human confirmation.
- No model-authored SQL, prices, stock figures or order data.
- No production payment credentials. Razorpay test mode only.
- No stored audio, and no payment credentials anywhere near the AI or Sarvam.
- No fabricated analytics. Empty is shown as empty.
