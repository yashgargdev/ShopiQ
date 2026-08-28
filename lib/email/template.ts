import { formatPrice } from '@/lib/format';

/**
 * HTML email templates.
 *
 * Email is not the web. Three constraints shape everything here:
 *
 *  1. **Tables, not flexbox.** Outlook renders through Word's engine, which
 *     has no grid, no flex and no modern box model.
 *  2. **Inline styles only.** Gmail strips `<style>` blocks in several
 *     contexts, so any style that must survive is on the element.
 *  3. **A plain-text part always ships alongside.** It is what screen readers,
 *     text clients and spam filters read, and a message with no text part
 *     scores worse for deliverability.
 *
 * The dark palette matches ShopiQ, but every layer paints its own background
 * — a client that ignores one still gets a readable message rather than dark
 * text on dark.
 */

const LOGO_URL =
  process.env.EMAIL_LOGO_URL ?? 'https://cdn.shopiq.yashgarg.co.in/Logo/ShopiQ.png';
/**
 * The URL that goes INTO emails.
 *
 * Deliberately not NEXT_PUBLIC_SITE_URL on its own: in development that is
 * http://localhost:3000, and a real invoice carrying a localhost link is a
 * dead link in someone's inbox. A loopback value is ignored in favour of the
 * public domain, and EMAIL_SITE_URL overrides both for staging.
 */
const SITE_URL = (() => {
  const explicit = process.env.EMAIL_SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim() ?? '';
  const isLoopback = /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\./i.test(
    configured,
  );
  if (!configured || isLoopback) return 'https://shopiq.yashgarg.co.in';
  return configured.replace(/\/+$/, '');
})();
const SUPPORT_EMAIL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? 'shopiq@yashgarg.co.in';

const INK = '#EDEDF0';
const MUTED = '#9A9AA2';
const PAGE = '#08080A';
const CARD = '#101014';
const LINE = '#23232A';
const BRAND = '#F7931E';

/** Escape anything that reaches the HTML body. Order names are user data. */
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface EmailShellOptions {
  /** Shown under the logo. Short. */
  heading: string;
  /** One line under the heading. */
  subheading?: string | null;
  /** Pre-built HTML for the body. */
  body: string;
  /** Optional call to action. */
  action?: { label: string; url: string } | null;
  /** Small print above the footer. */
  note?: string | null;
  /** Hidden one-liner shown in the inbox list beside the subject. */
  preheader: string;
}

export function renderShell(options: EmailShellOptions): string {
  const action = options.action
    ? `
      <tr>
        <td style="padding:26px 32px 0;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td bgcolor="${BRAND}" style="border-radius:10px;">
                <a href="${esc(options.action.url)}"
                   style="display:inline-block;padding:13px 26px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#1A0D02;text-decoration:none;border-radius:10px;">
                  ${esc(options.action.label)}
                </a>
              </td>
            </tr>
          </table>
        </td>
      </tr>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>${esc(options.heading)}</title>
</head>
<body style="margin:0;padding:0;background-color:${PAGE};">
<!-- Preheader: shown in the inbox preview, hidden in the message itself. -->
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;height:0;width:0;">
  ${esc(options.preheader)}
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAGE}" style="background-color:${PAGE};">
  <tr>
    <td align="center" style="padding:32px 16px;">

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
             style="max-width:560px;background-color:${CARD};border:1px solid ${LINE};border-radius:16px;">

        <!--
          Lockup: small icon + the wordmark as TEXT.

          Most clients block remote images by default, so a wordmark that is
          part of the picture disappears exactly when branding matters most.
          Text always renders, and the icon becomes decoration rather than the
          only thing carrying the name.
        -->
        <tr>
          <td align="center" style="padding:28px 32px 0;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td valign="middle" style="padding-right:10px;">
                  <img src="${LOGO_URL}" width="30" height="30" alt=""
                       style="display:block;width:30px;height:30px;border:0;outline:none;border-radius:7px;">
                </td>
                <td valign="middle" style="font-family:Arial,Helvetica,sans-serif;font-size:21px;line-height:30px;font-weight:bold;letter-spacing:-0.02em;color:${INK};">
                  Shopi<span style="color:${BRAND};">Q</span>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Heading -->
        <tr>
          <td align="center" style="padding:24px 32px 0;">
            <h1 style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:22px;line-height:1.3;font-weight:bold;color:${INK};">
              ${esc(options.heading)}
            </h1>
            ${
              options.subheading
                ? `<p style="margin:8px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:${MUTED};">${esc(options.subheading)}</p>`
                : ''
            }
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:24px 32px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:${INK};">
            ${options.body}
          </td>
        </tr>

        ${action}

        ${
          options.note
            ? `<tr><td style="padding:22px 32px 0;font-family:Arial,Helvetica,sans-serif;font-size:12.5px;line-height:1.55;color:${MUTED};">${esc(options.note)}</td></tr>`
            : ''
        }

        <!-- Footer -->
        <tr>
          <td style="padding:28px 32px 30px;">
            <div style="height:1px;background-color:${LINE};font-size:0;line-height:0;">&nbsp;</div>
            <p style="margin:18px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;color:#6E6E76;">
              ShopiQ · <a href="${SITE_URL}" style="color:${MUTED};text-decoration:underline;">${esc(SITE_URL.replace(/^https?:\/\//, ''))}</a><br>
              Questions? Reply to this email or write to
              <a href="mailto:${SUPPORT_EMAIL}" style="color:${MUTED};text-decoration:underline;">${esc(SUPPORT_EMAIL)}</a>.
            </p>
          </td>
        </tr>
      </table>

    </td>
  </tr>
</table>
</body>
</html>`;
}

/* ------------------------------------------------------------- invoice */

export interface InvoiceLine {
  name: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

export interface InvoiceInput {
  orderNumber: string;
  lines: InvoiceLine[];
  subtotal: number;
  shipping: number;
  tax: number;
  total: number;
  deliveryEstimate: string;
  address: Record<string, unknown> | null;
  paymentStatus: string;
}

function addressLine(address: Record<string, unknown> | null): string {
  if (!address) return 'Not provided';
  return [
    address.line1,
    address.line2,
    address.city,
    address.state,
    address.postalCode ?? address.postal_code,
    address.country,
  ]
    .filter(Boolean)
    .join(', ');
}

/** A money row in the totals block. `strong` marks the grand total. */
function totalRow(label: string, value: string, strong = false): string {
  return `
    <tr>
      <td style="padding:5px 0;font-family:Arial,Helvetica,sans-serif;font-size:${strong ? '15px' : '13.5px'};color:${strong ? INK : MUTED};${strong ? 'font-weight:bold;' : ''}">${esc(label)}</td>
      <td align="right" style="padding:5px 0;font-family:Arial,Helvetica,sans-serif;font-size:${strong ? '17px' : '13.5px'};color:${INK};${strong ? 'font-weight:bold;' : ''}">${esc(value)}</td>
    </tr>`;
}

export function renderInvoiceEmail(input: InvoiceInput): {
  subject: string;
  html: string;
  text: string;
} {
  const items = input.lines
    .map(
      (line) => `
      <tr>
        <td style="padding:11px 0;border-bottom:1px solid ${LINE};font-family:Arial,Helvetica,sans-serif;font-size:14px;color:${INK};">
          ${esc(line.name)}
          <div style="font-size:12.5px;color:${MUTED};padding-top:3px;">Qty ${line.quantity} × ${esc(formatPrice(line.unitPrice))}</div>
        </td>
        <td align="right" valign="top" style="padding:11px 0;border-bottom:1px solid ${LINE};font-family:Arial,Helvetica,sans-serif;font-size:14px;color:${INK};white-space:nowrap;">
          ${esc(formatPrice(line.total))}
        </td>
      </tr>`,
    )
    .join('');

  const paid = input.paymentStatus === 'paid';

  const body = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="padding-bottom:6px;font-family:Arial,Helvetica,sans-serif;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:${MUTED};">Order</td>
      </tr>
      <tr>
        <td style="padding-bottom:18px;font-family:'Courier New',Courier,monospace;font-size:16px;color:${BRAND};">${esc(input.orderNumber)}</td>
      </tr>
    </table>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${items}</table>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="padding-top:14px;">
      ${totalRow('Subtotal', formatPrice(input.subtotal))}
      ${totalRow('Delivery', input.shipping === 0 ? 'Free' : formatPrice(input.shipping))}
      ${input.tax > 0 ? totalRow('Tax', formatPrice(input.tax)) : ''}
      ${totalRow('Total', formatPrice(input.total), true)}
    </table>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:22px;">
      <tr>
        <td style="padding:14px 16px;background-color:#08080A;border:1px solid ${LINE};border-radius:10px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.6;color:${INK};">
          <span style="color:${MUTED};">Payment</span><br>
          <strong style="color:${paid ? '#4ADE80' : BRAND};">${paid ? 'Paid' : esc(input.paymentStatus)}</strong>
          <div style="height:12px;line-height:12px;font-size:0;">&nbsp;</div>
          <span style="color:${MUTED};">Delivering to</span><br>
          ${esc(addressLine(input.address))}
          <div style="height:12px;line-height:12px;font-size:0;">&nbsp;</div>
          <span style="color:${MUTED};">Expected</span><br>
          ${esc(input.deliveryEstimate)}
        </td>
      </tr>
    </table>`;

  const text = `ShopiQ — order ${input.orderNumber}

${input.lines.map((l) => `  ${l.name}\n    ${l.quantity} x ${formatPrice(l.unitPrice)} = ${formatPrice(l.total)}`).join('\n')}

Subtotal   ${formatPrice(input.subtotal)}
Delivery   ${input.shipping === 0 ? 'Free' : formatPrice(input.shipping)}
${input.tax > 0 ? `Tax        ${formatPrice(input.tax)}\n` : ''}Total      ${formatPrice(input.total)}

Payment: ${paid ? 'Paid' : input.paymentStatus}
Delivering to: ${addressLine(input.address)}
Expected: ${input.deliveryEstimate}

Track this order at ${SITE_URL}/orders
Questions? ${SUPPORT_EMAIL}
`;

  return {
    subject: `Your ShopiQ order ${input.orderNumber}`,
    html: renderShell({
      heading: paid ? 'Order confirmed' : 'Order received',
      subheading: `Thanks — we'll have it with you in about ${input.deliveryEstimate}.`,
      preheader: `${input.orderNumber} · ${formatPrice(input.total)} · arriving in ${input.deliveryEstimate}`,
      body,
      action: { label: 'View your order', url: `${SITE_URL}/orders` },
      note: 'This is your invoice — keep it for your records.',
    }),
    text,
  };
}

/* ------------------------------------------------- account / sign-in code */

export function renderAccountCreatedEmail(input: { email: string }): {
  subject: string;
  html: string;
  text: string;
} {
  const body = `
    <p style="margin:0 0 14px;">Your ShopiQ account is ready, so you can track this order and any future ones.</p>
    <p style="margin:0;color:${MUTED};">
      There's no password to remember. When you want to sign in, ShopiQ emails a
      six-digit code to <strong style="color:${INK};">${esc(input.email)}</strong> and that's it.
    </p>`;

  return {
    subject: 'Your ShopiQ account is ready',
    html: renderShell({
      heading: 'Account created',
      subheading: 'No password needed — ever.',
      preheader: 'Sign in any time with a six-digit code. No password required.',
      body,
      action: { label: 'Talk to ShopiQ', url: `${SITE_URL}/Agent-purchase` },
      note: "We'll never email you a password, and nobody at ShopiQ can see one.",
    }),
    text: `Your ShopiQ account is ready.

There's no password to remember. To sign in, ShopiQ emails a six-digit code to
${input.email}.

We will never email you a password.

${SITE_URL}/Agent-purchase
`,
  };
}

/**
 * Support-request acknowledgement.
 *
 * Carefully worded: a request is recorded, not granted. Promising a refund
 * here would commit the merchant to something the assistant has no authority
 * to decide.
 */
export function renderSupportEmail(input: {
  orderNumber: string;
  kind: 'return' | 'replacement';
  reason: string;
}): { subject: string; html: string; text: string } {
  const noun = input.kind === 'return' ? 'Return' : 'Replacement';

  const body = `
    <p style="margin:0 0 14px;">We've logged your ${esc(input.kind)} request for order
      <strong style="color:${BRAND};font-family:'Courier New',Courier,monospace;">${esc(input.orderNumber)}</strong>.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="padding:14px 16px;background-color:#08080A;border:1px solid ${LINE};border-radius:10px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.6;color:${INK};">
          <span style="color:${MUTED};">Your reason</span><br>${esc(input.reason)}
        </td>
      </tr>
    </table>
    <p style="margin:16px 0 0;color:${MUTED};">Our team will review it and email you the next steps.</p>`;

  return {
    subject: `${noun} request received — ${input.orderNumber}`,
    html: renderShell({
      heading: `${noun} request received`,
      subheading: "We'll be in touch shortly.",
      preheader: `${noun} request logged for ${input.orderNumber}.`,
      body,
      action: { label: 'View your orders', url: `${SITE_URL}/orders` },
      note: 'Reviewing a request does not automatically approve it — we will confirm by email.',
    }),
    text: `${noun} request received for order ${input.orderNumber}.

Your reason: ${input.reason}

Our team will review it and email you the next steps. Reviewing a request does
not automatically approve it.

${SITE_URL}/orders
`,
  };
}

/** Cancellation confirmation. */
export function renderCancellationEmail(input: {
  orderNumber: string;
  total: number;
  wasPaid: boolean;
}): { subject: string; html: string; text: string } {
  const body = `
    <p style="margin:0 0 14px;">Order
      <strong style="color:${BRAND};font-family:'Courier New',Courier,monospace;">${esc(input.orderNumber)}</strong>
      has been cancelled and nothing will be shipped.</p>
    <p style="margin:0;color:${MUTED};">${
      input.wasPaid
        ? `Your payment of <strong style="color:${INK};">${esc(formatPrice(input.total))}</strong> will be refunded to the original payment method. Banks usually take 5–7 working days.`
        : 'No payment was taken for this order.'
    }</p>`;

  return {
    subject: `Order ${input.orderNumber} cancelled`,
    html: renderShell({
      heading: 'Order cancelled',
      subheading: input.wasPaid ? 'Your refund is on its way.' : 'Nothing was charged.',
      preheader: `${input.orderNumber} cancelled.${input.wasPaid ? ' Refund on its way.' : ''}`,
      body,
      action: { label: 'Talk to ShopiQ', url: `${SITE_URL}/Agent-purchase` },
      note: null,
    }),
    text: `Order ${input.orderNumber} has been cancelled and nothing will be shipped.

${
  input.wasPaid
    ? `Your payment of ${formatPrice(input.total)} will be refunded to the original payment method. Banks usually take 5-7 working days.`
    : 'No payment was taken for this order.'
}

${SITE_URL}/Agent-purchase
`,
  };
}
