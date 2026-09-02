# Security Policy

ShopiQ lets a language model participate in a purchase. Most of its
architecture exists to bound what that model can cause to happen, so security
reports here are especially welcome — particularly ones that show a guarantee
below does not hold.

## Reporting a vulnerability

**Please do not open a public issue.**

Email **shopiq@yashgarg.co.in** with:

- what the issue is, and what an attacker could achieve with it
- the steps to reproduce it — for a conversational exploit, the exact wording
  used, since phrasing is usually the payload
- the affected version or commit
- anything you think mitigates or worsens it

You should get an acknowledgement within **72 hours**, and an assessment with a
fix or a timeline within **7 days**. If you do not hear back, please email
again rather than assuming it was received.

Please give a reasonable window to ship a fix before disclosing publicly. Credit
will be given in the release notes unless you prefer otherwise.

## Supported versions

This is a demonstration project. Fixes land on `main`; there are no maintained
release branches.

| Version | Supported |
|---|---|
| `main` | ✅ |
| tagged releases | ❌ |

## What counts as a vulnerability here

Beyond the usual web classes, these are the properties the project claims. A
demonstration that any of them can be broken is a security bug:

**Money**
- Causing a charge for an amount the customer did not explicitly authorise
- Influencing a price, discount, tax, shipping cost or total through
  conversation
- Producing an order without a verified payment, or a payment without an order

**Identity and data**
- Reading or modifying another customer's account, orders, addresses or cart
- Getting the assistant to act on an account other than the signed-in one, by
  naming an email address, an order number, or any other identifier
- Bypassing Row Level Security, or reaching a `SECURITY DEFINER` function that
  should be service-role only

**Secrets**
- Any route, bundle or response that exposes `SUPABASE_SERVICE_ROLE_KEY`,
  `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `SARVAM_API_KEY`,
  `ANTHROPIC_API_KEY` or the SMTP credentials to the browser

**Integrity**
- Forging a Razorpay signature that the server accepts
- Replaying a webhook to duplicate an order or a refund
- Prompt injection — via a product name, review, or any other stored text —
  that causes a tool call the customer did not ask for

**Not in scope**
- The demo catalogue containing invented prices, ratings and reviews. It is
  labelled as demo data throughout; that is intentional, not a
  misrepresentation.
- Rate limiting on a local development server
- Findings that require a compromised `.env.local`, a stolen service role key,
  or physical access to the machine
- Missing hardening headers on a `next dev` server

## What the project already asserts

`npm run test:security` exercises these continuously. If you are looking for
somewhere to probe, the gaps in that suite are the interesting places:

- A signature that does not verify is rejected, even with valid keys present
- A confirmed amount is re-checked server-side before capture
- One conversation cannot read another's history
- Service-role-only database functions refuse `anon` and `authenticated`
- Prompt-injection attempts are handled rather than crashing the turn

## Hardening for your own deployment

If you deploy a fork, at minimum:

1. Use **your own** Supabase project, Razorpay account and API keys. Never reuse
   the ones in any example.
2. Keep Razorpay in **test mode** unless you intend to move real money. A key
   beginning `rzp_live_` does.
3. Set `RAZORPAY_WEBHOOK_SECRET` and verify webhook signatures — an unverified
   webhook endpoint is a way to fabricate paid orders.
4. Never expose `SUPABASE_SERVICE_ROLE_KEY` to the client. It bypasses every RLS
   policy in the database.
5. Rotate anything that has ever been pasted into a chat, a screenshot, a log or
   an issue.

See [`docs/security.md`](docs/security.md) for the threat model in full.
