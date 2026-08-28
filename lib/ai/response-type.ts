import type { AgentReply } from './types';

/**
 * The structured response type.
 *
 * Phase 5 §20 asks the AI to return a structure the frontend renders, rather
 * than markup. ShopiQ already worked that way — the model has never produced
 * UI, only prose about payloads the backend computed. What was missing was a
 * single label saying WHICH payload this turn carries, so a renderer does not
 * have to re-derive it from four nullable fields.
 *
 * This is derived on the server from what the turn actually produced. It is
 * not something the model chooses, so it cannot be wrong about itself.
 */
export type AiResponseType =
  | 'text'
  | 'product_recommendations'
  | 'product_detail'
  | 'comparison'
  | 'cart'
  | 'checkout'
  | 'purchase_confirmation'
  | 'payment'
  | 'order'
  | 'error';

export function responseTypeFor(reply: AgentReply): AiResponseType {
  if (reply.outcome === 'error') return 'error';

  // Ordered by specificity: a turn that produced a payment is a payment turn
  // even though it also has a cart behind it.
  if (reply.order) return 'order';
  if (reply.payment) return 'payment';
  if (reply.purchase) return 'purchase_confirmation';
  if (reply.checkout) return 'checkout';
  if (reply.cart) return 'cart';
  if (reply.comparison) return 'comparison';

  if (reply.products.length === 1 && reply.intent === 'product_question') return 'product_detail';
  if (reply.products.length > 0) return 'product_recommendations';

  return 'text';
}

/**
 * The short line ShopiQ should SAY, as opposed to what it displays.
 *
 * Reading a product grid aloud is unbearable, so speech gets the headline and
 * the screen keeps the detail. This trims the assistant's own message rather
 * than generating a second one — the spoken and written words stay the same
 * words, which matters when someone is checking a price.
 */
export function speakableSummary(reply: AgentReply, maxChars = 320): string {
  const message = (reply.message ?? '').trim();
  if (!message) return '';

  if (message.length <= maxChars) return message;

  // Cut on a sentence boundary where one exists, so speech never stops
  // mid-clause.
  const clipped = message.slice(0, maxChars);
  const lastStop = Math.max(
    clipped.lastIndexOf('. '),
    clipped.lastIndexOf('! '),
    clipped.lastIndexOf('? '),
    clipped.lastIndexOf('। '),
  );
  if (lastStop > maxChars * 0.5) return clipped.slice(0, lastStop + 1).trim();

  const lastSpace = clipped.lastIndexOf(' ');
  return `${clipped.slice(0, lastSpace > 0 ? lastSpace : maxChars).trim()}…`;
}

/**
 * Whether a turn is worth speaking at all.
 *
 * Silence is a feature: re-reading a cart the customer just watched update is
 * noise, and speaking every acknowledgement makes the assistant feel chatty
 * rather than useful.
 */
export function shouldSpeak(reply: AgentReply): boolean {
  if (!reply.message?.trim()) return false;
  // Everything else is worth hearing — recommendations, cart changes,
  // checkout totals, order confirmations and errors all carry information the
  // customer is waiting on.
  return true;
}
