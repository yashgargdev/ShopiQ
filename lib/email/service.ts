import 'server-only';
import { adminClient } from '@/lib/supabase/admin';
import { formatPrice } from '@/lib/format';

/**
 * Transactional email.
 *
 * Two rules, both learned from the failure mode this is guarding against:
 *
 *  1. **The row is written before the send is attempted.** An email that fails
 *     is then visible and retryable rather than lost, and the order it belongs
 *     to is unaffected.
 *  2. **A failed email never rolls back a paid order.** The customer has been
 *     charged; the goods are theirs. A missing invoice is an inconvenience to
 *     fix, not a reason to unwind a payment.
 *
 * With no provider configured, mail is queued and left `queued` — honestly
 * pending, never reported as sent. Account-setup links are the exception: those
 * go through Supabase Auth, which sends its own email and never exposes a
 * password to us or to the AI.
 */

export type EmailKind = 'order_invoice' | 'account_setup' | 'order_status';

export interface SendEmailInput {
  kind: EmailKind;
  to: string;
  subject: string;
  /** Plain text. Always sent — it is what text clients and filters read. */
  body: string;
  /** Optional HTML part. When present the message goes out multipart. */
  html?: string | null;
  orderId?: string | null;
  customerId?: string | null;
}

export interface EmailResult {
  id: string;
  status: 'queued' | 'sent' | 'failed';
  provider: string | null;
  error?: string | null;
}

function resendKey(): string | null {
  return process.env.RESEND_API_KEY?.trim() || null;
}

interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  secure: boolean;
}

/**
 * SMTP, when configured. Preferred over Resend because it is the same
 * transport Supabase Auth can be pointed at, so the OTP mail and the invoice
 * come from one sender rather than two unrelated ones.
 */
function smtpConfig(): SmtpConfig | null {
  const host = process.env.SMTP_HOST?.trim();
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASSWORD?.trim();
  if (!host || !user || !pass) return null;

  const port = Number(process.env.SMTP_PORT ?? 587);
  return {
    host,
    port,
    user,
    pass,
    // 465 is implicit TLS; 587 and 25 start plaintext and upgrade via
    // STARTTLS. Getting this backwards is the classic silent SMTP hang.
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
  };
}

function fromAddress(): string {
  return process.env.EMAIL_FROM?.trim() || 'ShopiQ <shopiq@yashgarg.co.in>';
}

/** True when a real transport can actually deliver. */
export function emailConfigured(): boolean {
  return Boolean(smtpConfig() || resendKey());
}

export function emailStatus(): {
  provider: 'smtp' | 'resend' | 'outbox';
  configured: boolean;
  host?: string;
} {
  const smtp = smtpConfig();
  if (smtp) return { provider: 'smtp', configured: true, host: smtp.host };
  if (resendKey()) return { provider: 'resend', configured: true };
  return { provider: 'outbox', configured: false };
}

/** Deliver over SMTP. Returns an error string, or null on success. */
async function sendViaSmtp(
  config: SmtpConfig,
  input: { to: string; subject: string; body: string; html?: string | null },
): Promise<string | null> {
  try {
    const nodemailer = await import('nodemailer');
    const transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.user, pass: config.pass },
      // A hung SMTP connection must not hold a checkout response open.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });

    await transport.sendMail({
      from: fromAddress(),
      to: input.to,
      subject: input.subject,
      // Both parts, always. A message with only HTML scores worse with spam
      // filters and is unreadable in a text client.
      text: input.body,
      ...(input.html ? { html: input.html } : {}),
    });
    transport.close();
    return null;
  } catch (cause) {
    return cause instanceof Error ? cause.message.slice(0, 300) : 'smtp failed';
  }
}

/**
 * Queue an email, then attempt delivery.
 *
 * Never throws. The caller is always in the middle of something more important
 * than an email.
 */
export async function sendEmail(input: SendEmailInput): Promise<EmailResult> {
  const db = adminClient();

  const { data: queued, error } = await db
    .from('email_outbox')
    .insert({
      kind: input.kind,
      to_email: input.to,
      subject: input.subject.slice(0, 300),
      body_text: input.body,
      order_id: input.orderId ?? null,
      customer_id: input.customerId ?? null,
      status: 'queued',
      provider: emailStatus().provider === 'outbox' ? null : emailStatus().provider,
    })
    .select('id')
    .single();

  if (error || !queued) {
    console.error('[email] could not queue', error);
    return { id: '', status: 'failed', provider: null, error: error?.message ?? 'queue failed' };
  }

  const smtp = smtpConfig();
  if (smtp) {
    const failure = await sendViaSmtp(smtp, {
      to: input.to,
      subject: input.subject,
      body: input.body,
      html: input.html ?? null,
    });

    if (failure) {
      await db
        .from('email_outbox')
        .update({ status: 'failed', error: failure, attempts: 1 })
        .eq('id', queued.id);
      return { id: queued.id, status: 'failed', provider: 'smtp', error: failure };
    }

    await db
      .from('email_outbox')
      .update({ status: 'sent', sent_at: new Date().toISOString(), attempts: 1 })
      .eq('id', queued.id);
    return { id: queued.id, status: 'sent', provider: 'smtp' };
  }

  if (!resendKey()) {
    // No transport. The row stays `queued` — pending, not pretended-sent.
    return { id: queued.id, status: 'queued', provider: null };
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromAddress(),
        to: [input.to],
        subject: input.subject,
        text: input.body,
        ...(input.html ? { html: input.html } : {}),
      }),
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      await db
        .from('email_outbox')
        .update({ status: 'failed', error: detail, attempts: 1 })
        .eq('id', queued.id);
      return { id: queued.id, status: 'failed', provider: 'resend', error: detail };
    }

    await db
      .from('email_outbox')
      .update({ status: 'sent', sent_at: new Date().toISOString(), attempts: 1 })
      .eq('id', queued.id);
    return { id: queued.id, status: 'sent', provider: 'resend' };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message.slice(0, 300) : 'unknown';
    await db.from('email_outbox').update({ status: 'failed', error: detail, attempts: 1 }).eq('id', queued.id);
    return { id: queued.id, status: 'failed', provider: 'resend', error: detail };
  }
}

export interface InvoiceLine {
  name: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

/** The order confirmation / invoice. Plain text: it renders everywhere. */
export function renderInvoice(input: {
  orderNumber: string;
  lines: InvoiceLine[];
  subtotal: number;
  shipping: number;
  tax: number;
  total: number;
  deliveryEstimate: string;
  address: Record<string, unknown> | null;
  paymentStatus: string;
}): { subject: string; body: string } {
  const rows = input.lines
    .map(
      (line) =>
        `  ${line.name}\n    ${line.quantity} × ${formatPrice(line.unitPrice)} = ${formatPrice(line.total)}`,
    )
    .join('\n');

  const address = input.address
    ? [
        input.address.line1,
        input.address.line2,
        input.address.city,
        input.address.state,
        input.address.postalCode,
        input.address.country,
      ]
        .filter(Boolean)
        .join(', ')
    : 'Not provided';

  return {
    subject: `Your ShopiQ order ${input.orderNumber}`,
    body: `Thanks for shopping with ShopiQ.

ORDER ${input.orderNumber}
Payment: ${input.paymentStatus}

ITEMS
${rows}

Subtotal   ${formatPrice(input.subtotal)}
Delivery   ${input.shipping === 0 ? 'Free' : formatPrice(input.shipping)}
${input.tax > 0 ? `Tax        ${formatPrice(input.tax)}\n` : ''}Total      ${formatPrice(input.total)}

DELIVERY
${address}
Expected: ${input.deliveryEstimate}

You can track this order in your ShopiQ account.

— ShopiQ
shopiq.yashgarg.co.in
`,
  };
}

/**
 * Create (or find) an account for a guest and send them a password-setup link.
 *
 * The password is never chosen by the AI, never spoken, never emailed. Supabase
 * Auth generates a single-use recovery link and delivers it; we only record
 * that we asked it to.
 *
 * An email that already belongs to an account does NOT get a new one and does
 * NOT get a setup link — that would be an account-takeover primitive, since
 * anyone can type someone else's address into a voice checkout.
 */
export async function ensureAccountForEmail(input: {
  email: string;
  fullName: string | null;
  phone: string | null;
}): Promise<{ customerId: string | null; created: boolean; setupEmailQueued: boolean }> {
  const db = adminClient();
  const email = input.email.trim().toLowerCase();

  // Does a customer already exist for this address?
  const { data: existing } = await db
    .from('customers')
    .select('id')
    .ilike('email', email)
    .maybeSingle();

  if (existing) {
    // Link the order to the existing account, but send no setup link and
    // disclose nothing about the account back to the caller or the AI.
    return { customerId: existing.id, created: false, setupEmailQueued: false };
  }

  const { data: created, error } = await db.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { full_name: input.fullName ?? null, created_via: 'agent_checkout' },
  });

  if (error || !created?.user) {
    console.error('[email] account creation failed', error);
    return { customerId: null, created: false, setupEmailQueued: false };
  }

  await db.from('customers').upsert({
    id: created.user.id,
    email,
    full_name: input.fullName ?? null,
    phone: input.phone ?? null,
  });

  // No password-recovery link is sent. ShopiQ has no passwords at all now:
  // signing in means asking for a six-digit code by email, so a "set your
  // password" mail would point at a screen that does not exist.
  const setupEmailQueued = true;

  const { renderAccountCreatedEmail } = await import('./template');
  const welcome = renderAccountCreatedEmail({ email });
  await sendEmail({
    kind: 'account_setup',
    to: email,
    subject: welcome.subject,
    body: welcome.text,
    html: welcome.html,
    customerId: created.user.id,
  });

  return { customerId: created.user.id, created: true, setupEmailQueued };
}
