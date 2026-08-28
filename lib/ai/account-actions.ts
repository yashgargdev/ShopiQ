import 'server-only';

import { getSessionUser } from '@/lib/auth';
import { listAddresses } from '@/lib/account/addresses';

import {
  cancelOrder,
  getOrderByNumber,
  getProfile,
  listMyOrders,
  requestSupport,
  updateProfile,
  type OrderSummary,
} from './tools/account';
import { buildPendingAction, type PendingAction } from './confirm';
import type { CartTurnResult } from './cart-actions';

/**
 * The customer's own account, answered in conversation.
 *
 * Every one of these reads identity from the SESSION and nowhere else. There
 * is no parameter on any of them naming a customer, an email or an id, so
 * there is no phrasing that makes the assistant fetch or edit somebody else's
 * profile — the model cannot supply an identity it is never asked for.
 *
 * These handlers exist because the tools they call were registered from the
 * start but nothing routed to them. Account questions fell through to the
 * product classifier, where "change my phone number" searched the smartphone
 * category and "add a new address" offered to add a Galaxy S26.
 */

const EMPTY: Omit<CartTurnResult, 'message' | 'outcome'> = {
  cart: null,
  checkout: null,
  products: [],
  actions: [],
  pendingAction: null,
};

const reply = (message: string, outcome: CartTurnResult['outcome'] = 'answer'): CartTurnResult => ({
  ...EMPTY,
  message,
  outcome,
});

/**
 * Everything here needs a signed-in customer.
 *
 * The refusal names the way in, because the sign-in dialog lives in the header
 * and there is no login page to send anyone to.
 */
async function requireSignIn(what: string): Promise<CartTurnResult | null> {
  const user = await getSessionUser();
  if (user) return null;
  return reply(
    `You'll need to sign in before I can ${what}. Use the Sign in button at the top right — ShopiQ emails you a code, there is no password.`,
    'clarify',
  );
}

/* ---------------------------------------------------------------- profile */

export async function handleProfileView(): Promise<CartTurnResult> {
  const blocked = await requireSignIn('show you your profile');
  if (blocked) return blocked;

  const profile = await getProfile();
  const parts = [
    `Name: ${profile.full_name ?? 'not set'}`,
    `Email: ${profile.email ?? 'not set'}`,
    `Phone: ${profile.phone ?? 'not set'}`,
  ];

  const missing = [
    profile.full_name ? null : 'name',
    profile.phone ? null : 'phone number',
  ].filter(Boolean);

  const nudge =
    missing.length > 0
      ? ` Tell me your ${missing.join(' and ')} and I'll fill ${missing.length === 1 ? 'it' : 'them'} in.`
      : ' Tell me what to change and I can update it.';

  return {
    ...EMPTY,
    message: `Here's your profile — ${parts.join(', ')}.${nudge}`,
    outcome: 'answer',
    actions: [{ type: 'view_profile' }],
  };
}

/** An Indian mobile number, in any of the shapes people actually type. */
const PHONE = /(?:\+?91[\s-]?)?([6-9]\d{4}[\s-]?\d{5})\b/;

/**
 * A name given as an instruction: "change my name to X", "my name is X".
 *
 * Anchored on the instruction rather than guessing at capitalised words, so an
 * ordinary sentence mentioning a brand does not rewrite the customer's name.
 */
const NAME =
  /\b(?:name|naam)\s+(?:to|is|should be|ko|=)\s+["']?([\p{L}][\p{L}\s.'-]{1,60}?)["']?\s*$|\b(?:change|update|set|correct)\s+my\s+name\s+to\s+["']?([\p{L}][\p{L}\s.'-]{1,60}?)["']?\s*$/iu;

export async function handleProfileUpdate(message: string): Promise<CartTurnResult> {
  const blocked = await requireSignIn('change your details');
  if (blocked) return blocked;

  const phoneMatch = PHONE.exec(message);
  const nameMatch = NAME.exec(message);
  const name = (nameMatch?.[1] ?? nameMatch?.[2] ?? '').trim();

  // Nothing usable in the message — say what can be changed rather than
  // silently doing nothing.
  if (!phoneMatch && !name) {
    return reply(
      'I can change your name or your phone number. Tell me the new value — for example "change my name to Yash Garg" or "my number is 98765 43210". Your email is the credential your sign-in code goes to, so that one cannot be changed here.',
      'clarify',
    );
  }

  const result = await updateProfile({
    ...(name ? { full_name: name } : {}),
    ...(phoneMatch ? { phone: phoneMatch[0] } : {}),
  });

  if (result.updated.length === 0) {
    const what = result.rejected.join(' and ') || 'that';
    return reply(`I couldn't accept the ${what} — it didn't look valid. Try again?`, 'clarify');
  }

  // State the stored values back, read from the profile after the write rather
  // than echoing what was asked for. If validation normalised the phone
  // number, the customer sees what is actually saved.
  const saved = [
    result.updated.includes('name') ? `name is now ${result.profile.full_name}` : null,
    result.updated.includes('phone') ? `phone is now ${result.profile.phone}` : null,
  ]
    .filter(Boolean)
    .join(', and your ');

  const note =
    result.rejected.length > 0
      ? ` I couldn't accept the ${result.rejected.join(' or ')}, so that is unchanged.`
      : '';

  return {
    ...EMPTY,
    message: `Done — your ${saved}.${note}`,
    outcome: 'answer',
    actions: [{ type: 'view_profile' }],
  };
}

/* -------------------------------------------------------------- addresses */

export async function handleAddressList(): Promise<CartTurnResult> {
  const blocked = await requireSignIn('look up your addresses');
  if (blocked) return blocked;

  const addresses = await listAddresses();

  if (addresses.length === 0) {
    return {
      ...EMPTY,
      message:
        "You don't have any saved addresses yet. Add one and I'll use it at checkout — you can drop a pin on a map and it fills in the rest.",
      outcome: 'answer',
      actions: [{ type: 'add_address' }],
    };
  }

  const lines = addresses
    .map((address, index) => {
      const label = address.label ? `${address.label} — ` : '';
      const badge = address.isDefault ? ' (default)' : '';
      return `${index + 1}. ${label}${address.fullName}, ${[address.line1, address.city, address.postalCode].filter(Boolean).join(', ')}${badge}`;
    })
    .join('\n');

  return {
    ...EMPTY,
    message: `You have ${addresses.length} saved address${addresses.length === 1 ? '' : 'es'}:\n${lines}`,
    outcome: 'answer',
    actions: [{ type: 'view_addresses' }, { type: 'add_address' }],
  };
}

export async function handleAddressAdd(): Promise<CartTurnResult> {
  const blocked = await requireSignIn('save an address');
  if (blocked) return blocked;

  return {
    ...EMPTY,
    message:
      "Let's add one. Open the address form and use **Use my location** — it reads your GPS position and fills in the street, city, state and PIN, so you only check it and save. You can also type it in yourself.",
    outcome: 'answer',
    actions: [{ type: 'add_address' }],
  };
}

/* ----------------------------------------------------------------- orders */

function describeOrder(order: OrderSummary): string {
  const items = order.items
    .slice(0, 3)
    .map((item) => `${item.name} × ${item.quantity}`)
    .join(', ');
  const more = order.items.length > 3 ? ` and ${order.items.length - 3} more` : '';
  const placed = new Date(order.placed_at).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  return `${order.order_number} — ${order.status}, ${order.total_display}, placed ${placed}: ${items}${more}`;
}

export async function handleOrderList(): Promise<CartTurnResult> {
  const blocked = await requireSignIn('look up your orders');
  if (blocked) return blocked;

  const orders = await listMyOrders(5);

  if (orders.length === 0) {
    return reply(
      "You haven't placed any orders yet. Tell me what you're looking for and I'll help you find it.",
    );
  }

  const lines = orders.map((order) => `· ${describeOrder(order)}`).join('\n');

  // Only offer what the SERVER says is allowed. Deciding here would let the
  // sentence and the rule drift apart, and the customer would be offered an
  // action that fails when they take it.
  const cancellable = orders.filter((order) => order.can_cancel).length;
  const returnable = orders.filter((order) => order.can_return).length;
  const offers = [
    cancellable > 0 ? 'cancel one' : null,
    returnable > 0 ? 'start a return or replacement' : null,
  ].filter(Boolean);

  const tail = offers.length > 0 ? ` I can ${offers.join(' or ')} — just say which order.` : '';

  return {
    ...EMPTY,
    message: `Here ${orders.length === 1 ? 'is your order' : `are your last ${orders.length} orders`}:\n${lines}${tail}`,
    outcome: 'answer',
    actions: [{ type: 'view_orders' }],
  };
}

/** "SQ-2026-14" anywhere in the message. */
const ORDER_NUMBER = /\b(SQ-\d{4}-\d+)\b/i;

export const SELECT_ORDER = 'select_order';

export interface OrderSelection {
  /** What we are about to do once we know which order. */
  kind: 'cancel' | 'return' | 'replacement';
  /** The order numbers offered, in the order they were listed. */
  offered: string[];
  /** The customer's original words, so a stated reason survives the question. */
  reason: string;
}

/**
 * Read a parked "which order?" question.
 *
 * Without this the question was rhetorical: asking "cancel my order" listed the
 * candidates, and the answer arrived on the next turn with no memory that a
 * cancellation was ever in progress. It was classified from scratch — an order
 * number reads as a status enquiry — so the assistant cheerfully reported the
 * status of an order it had just been asked to cancel.
 */
export function readOrderSelection(action: PendingAction | null): OrderSelection | null {
  if (!action || action.action !== SELECT_ORDER) return null;
  const args = action.arguments;
  const kind = args.kind;
  if (kind !== 'cancel' && kind !== 'return' && kind !== 'replacement') return null;
  return {
    kind,
    offered: Array.isArray(args.offered) ? (args.offered as string[]) : [],
    reason: typeof args.reason === 'string' ? args.reason : '',
  };
}

/** Ask which order, and remember that we asked. */
function askWhichOrder(
  candidates: OrderSummary[],
  kind: OrderSelection['kind'],
  reason: string,
): CartTurnResult {
  const list = candidates
    .map((order, index) => `${index + 1}. ${describeOrder(order)}`)
    .join('\n');

  const verb = kind === 'cancel' ? 'cancel' : `start a ${kind} for`;

  return {
    ...EMPTY,
    message: `Which order should I ${verb}?\n${list}`,
    outcome: 'clarify',
    pendingAction: buildPendingAction(
      SELECT_ORDER,
      { kind, offered: candidates.map((order) => order.order_number), reason },
      `Choosing which order to ${verb}`,
    ),
  };
}

/**
 * Interpret an answer to a parked "which order?" question.
 *
 * Accepts the three ways people answer: the order number, a position in the
 * list just shown, or the name of something in the order. Returns null when
 * the message is none of those, so the caller can drop the question rather
 * than insisting on an answer to something the customer has moved on from.
 */
export async function handleOrderSelectionAnswer(
  message: string,
  selection: OrderSelection,
): Promise<CartTurnResult | null> {
  const blocked = await requireSignIn('do that');
  if (blocked) return blocked;

  let chosen: string | null = null;

  const stated = ORDER_NUMBER.exec(message);
  if (stated && selection.offered.includes(stated[1].toUpperCase())) {
    chosen = stated[1].toUpperCase();
  }

  // "the first one", "2", "second"
  if (!chosen) {
    const ordinals: Record<string, number> = {
      first: 1, '1st': 1, one: 1, second: 2, '2nd': 2, two: 2,
      third: 3, '3rd': 3, three: 3, fourth: 4, '4th': 4, four: 4,
    };
    const lower = message.toLowerCase();
    const bare = /^\s*(\d)\s*$/.exec(message);
    const position = bare
      ? Number(bare[1])
      : Object.entries(ordinals).find(([word]) => new RegExp(`\\b${word}\\b`).test(lower))?.[1];
    if (position && position >= 1 && position <= selection.offered.length) {
      chosen = selection.offered[position - 1];
    }
  }

  // "the iPhone one"
  if (!chosen) {
    const orders = await listMyOrders(10);
    const lower = message.toLowerCase();
    const byItem = orders.find(
      (order) =>
        selection.offered.includes(order.order_number) &&
        order.items.some((item) => {
          const words = item.name.toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
          return words.length > 0 && words.every((word) => lower.includes(word));
        }),
    );
    if (byItem) chosen = byItem.order_number;
  }

  if (!chosen) return null;

  if (selection.kind === 'cancel') {
    const result = await cancelOrder(chosen);
    return reply(result.message, result.ok ? 'answer' : 'clarify');
  }

  const result = await requestSupport(chosen, selection.kind, selection.reason.slice(0, 500));
  return reply(result.message, result.ok ? 'answer' : 'clarify');
}

/**
 * Work out which order the customer means.
 *
 * A stated order number wins. Otherwise, if exactly one order is eligible for
 * the action, that is unambiguous and is used. More than one and we ask —
 * cancelling the wrong order is not a recoverable mistake.
 */
async function resolveOrder(
  message: string,
  eligible: (order: OrderSummary) => boolean,
): Promise<{ order: OrderSummary | null; candidates: OrderSummary[]; ask: string | null }> {
  const stated = ORDER_NUMBER.exec(message);
  if (stated) {
    const order = await getOrderByNumber(stated[1].toUpperCase());
    if (!order) {
      return {
        order: null,
        candidates: [],
        ask: `I couldn't find an order numbered ${stated[1].toUpperCase()} on your account.`,
      };
    }
    return { order, candidates: [], ask: null };
  }

  const orders = await listMyOrders(10);
  const candidates = orders.filter(eligible);

  if (candidates.length === 0) {
    return {
      order: null,
      candidates: [],
      ask:
        orders.length === 0
          ? "You haven't placed any orders yet."
          : 'None of your orders can be changed that way right now.',
    };
  }
  if (candidates.length === 1) return { order: candidates[0], candidates, ask: null };

  // More than one is a real question, and it has to be remembered — see
  // askWhichOrder.
  return { order: null, candidates, ask: null };
}

export async function handleOrderCancel(message: string): Promise<CartTurnResult> {
  const blocked = await requireSignIn('cancel an order');
  if (blocked) return blocked;

  const { order, candidates, ask } = await resolveOrder(message, (c) => c.can_cancel);

  if (!order) {
    if (candidates.length > 1) return askWhichOrder(candidates, 'cancel', message);
    return reply(ask ?? 'Which order did you mean?', 'clarify');
  }

  if (!order.can_cancel) {
    return reply(
      `${order.order_number} is ${order.status}, so it can no longer be cancelled. If it has arrived I can start a return instead.`,
      'clarify',
    );
  }

  const result = await cancelOrder(order.order_number);
  return reply(result.message, result.ok ? 'answer' : 'clarify');
}

export async function handleOrderSupport(message: string): Promise<CartTurnResult> {
  const blocked = await requireSignIn('start a return or replacement');
  if (blocked) return blocked;

  const kind = /\b(replace|replacement|exchange|badal)\b/i.test(message) ? 'replacement' : 'return';

  const { order, candidates, ask } = await resolveOrder(message, (c) => c.can_return);

  if (!order) {
    if (candidates.length > 1) return askWhichOrder(candidates, kind, message);
    return reply(ask ?? 'Which order did you mean?', 'clarify');
  }

  const result = await requestSupport(order.order_number, kind, message.slice(0, 500));
  return reply(result.message, result.ok ? 'answer' : 'clarify');
}
