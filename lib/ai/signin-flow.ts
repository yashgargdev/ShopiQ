import 'server-only';

import { accountExists, sendCode, verifyCode } from '@/lib/auth/otp';
import { looksLikeEmail, normalisePhone } from '@/lib/checkout/guest';

import { buildPendingAction, type PendingAction } from './confirm';
import type { CartTurnResult } from './cart-actions';

/**
 * Signing in, as a conversation.
 *
 * Checkout used to run as a guest: details were collected, payment was taken,
 * and an account was created server-side afterwards — but nothing signed the
 * browser in. So the customer paid, and then every question about the order
 * they had just paid for was answered with "you need to sign in". The account
 * existed; the session never did.
 *
 * Signing in BEFORE payment removes that whole class of problem. The order has
 * an owner from the start, the address book is available to choose from, and
 * "where is my order" works the moment it is placed.
 *
 * The steps go through lib/auth/otp.ts — the same code the sign-in dialog
 * uses. Nothing about authentication is reimplemented here: this file decides
 * what to say and what to ask for next, and the emailed code remains the only
 * thing that can produce a session. Naming an address proves nothing and
 * grants nothing.
 */

export const SIGN_IN = 'sign_in';

export interface SignInState {
  stage: 'email' | 'details' | 'code';
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  /** What the customer was trying to do when we interrupted them. */
  resume: 'checkout' | null;
}

const EMPTY: Omit<CartTurnResult, 'message' | 'outcome'> = {
  cart: null,
  checkout: null,
  products: [],
  actions: [],
  pendingAction: null,
};

function park(state: SignInState, summary: string): PendingAction {
  return buildPendingAction(SIGN_IN, { ...state }, summary);
}

export function readSignInState(action: PendingAction | null): SignInState | null {
  if (!action || action.action !== SIGN_IN) return null;
  const args = action.arguments;
  const stage = args.stage;
  if (stage !== 'email' && stage !== 'details' && stage !== 'code') return null;
  return {
    stage,
    email: typeof args.email === 'string' ? args.email : null,
    firstName: typeof args.firstName === 'string' ? args.firstName : null,
    lastName: typeof args.lastName === 'string' ? args.lastName : null,
    phone: typeof args.phone === 'string' ? args.phone : null,
    resume: args.resume === 'checkout' ? 'checkout' : null,
  };
}

/** Begin the flow, explaining why we are asking. */
export function startSignIn(resume: 'checkout' | null): CartTurnResult {
  return {
    ...EMPTY,
    message:
      "Before I take a payment I'll get you signed in, so the order is on your account and you can track it afterwards. What's your email address?",
    outcome: 'clarify',
    pendingAction: park(
      { stage: 'email', email: null, firstName: null, lastName: null, phone: null, resume },
      'Signing in before checkout',
    ),
  };
}

/* ------------------------------------------------------------- extraction */

const EMAIL_IN_TEXT = /[^\s<>()[\]{},;:"']+@[^\s<>()[\]{},;:"']+\.[a-z]{2,}/i;
const CODE_ONLY = /\b(\d{4,10})\b/;

/**
 * A name, from a message that is mostly a name.
 *
 * Deliberately conservative: strips the polite framing people put around it
 * and refuses anything with an email or a long digit run in it, so "my email
 * is x@y.com" never becomes somebody's name.
 */
function extractName(message: string): { firstName: string; lastName: string } | null {
  if (EMAIL_IN_TEXT.test(message)) return null;

  const cleaned = message
    .replace(/\b(?:my|the|full)?\s*name\s*(?:is|:)?\b/gi, ' ')
    .replace(/\b(?:i\s*am|i'?m|this\s+is|it'?s|call\s+me)\b/gi, ' ')
    .replace(/\+?\d[\d\s-]{5,}/g, ' ')
    .replace(/[^\p{L}\s.'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = cleaned.split(' ').filter((word) => word.length >= 2 && word.length <= 40);
  if (words.length === 0 || words.length > 4) return null;

  const capitalise = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
  return {
    firstName: capitalise(words[0]),
    lastName: words.slice(1).map(capitalise).join(' '),
  };
}

const reply = (message: string, outcome: CartTurnResult['outcome'] = 'clarify'): CartTurnResult => ({
  ...EMPTY,
  message,
  outcome,
});

function askForCode(state: SignInState, sentMessage: string): CartTurnResult {
  return {
    ...EMPTY,
    message: `${sentMessage} Read it out or type it in and I'll sign you in.`,
    outcome: 'clarify',
    pendingAction: park({ ...state, stage: 'code' }, 'Waiting for the emailed code'),
  };
}

/* ---------------------------------------------------------------- stages */

export interface SignInOutcome {
  result: CartTurnResult;
  /** Set once the session exists, so the caller can carry on where it left off. */
  signedIn: boolean;
  resume: 'checkout' | null;
}

/**
 * Advance the flow by one message.
 *
 * Returns null when the message is not an answer to what was asked, so the
 * caller can drop the sign-in rather than trapping someone who changed their
 * mind in a loop they cannot leave.
 */
export async function handleSignInAnswer(
  message: string,
  state: SignInState,
): Promise<SignInOutcome | null> {
  /** Let people out. Being stuck in a sign-in you did not want is a trap. */
  if (/\b(cancel|stop|never ?mind|forget it|not now|later|chhodo|rehne do)\b/i.test(message)) {
    return {
      result: reply(
        "No problem — I've stopped there. Your cart is untouched, and we can pick this up whenever you like.",
        'cancelled',
      ),
      signedIn: false,
      resume: null,
    };
  }

  // ------------------------------------------------------------- email
  if (state.stage === 'email') {
    const found = EMAIL_IN_TEXT.exec(message);
    if (!found) return null;

    const email = found[0].trim().toLowerCase();
    if (!looksLikeEmail(email)) {
      return {
        result: reply("That doesn't look like an email address — could you say it again?"),
        signedIn: false,
        resume: null,
      };
    }

    // Whether the account exists decides what we ask next, but is never said
    // out loud: "this email has no account" tells a stranger who shops here.
    const existing = await accountExists(email);

    if (existing) {
      const sent = await sendCode({ email, scope: `agent:${email}` });
      if (!sent.ok) {
        return { result: reply(sent.message), signedIn: false, resume: null };
      }
      return {
        result: askForCode({ ...state, email }, sent.message),
        signedIn: false,
        resume: null,
      };
    }

    return {
      result: {
        ...EMPTY,
        message: `Thanks. I don't have an account for ${email} yet, so I'll set one up — what's your full name?`,
        outcome: 'clarify',
        pendingAction: park({ ...state, stage: 'details', email }, 'Collecting name and phone'),
      },
      signedIn: false,
      resume: null,
    };
  }

  // ----------------------------------------------------------- details
  if (state.stage === 'details') {
    const phone = normalisePhone(message);
    const name = extractName(message);

    const firstName = state.firstName ?? name?.firstName ?? null;
    const lastName = state.lastName ?? name?.lastName ?? null;
    const known = { ...state, firstName, lastName, phone: state.phone ?? phone };

    if (!firstName) {
      if (!phone) return null;
      return {
        result: {
          ...EMPTY,
          message: 'Got the number. And your full name?',
          outcome: 'clarify',
          pendingAction: park(known, 'Collecting name'),
        },
        signedIn: false,
        resume: null,
      };
    }

    if (!known.phone) {
      return {
        result: {
          ...EMPTY,
          message: `Thanks ${firstName}. What's your mobile number, for delivery updates?`,
          outcome: 'clarify',
          pendingAction: park(known, 'Collecting phone'),
        },
        signedIn: false,
        resume: null,
      };
    }

    const sent = await sendCode({
      email: known.email!,
      scope: `agent:${known.email}`,
      firstName: known.firstName,
      lastName: known.lastName,
      phone: known.phone,
    });
    if (!sent.ok) {
      return { result: reply(sent.message), signedIn: false, resume: null };
    }

    return { result: askForCode(known, sent.message), signedIn: false, resume: null };
  }

  // -------------------------------------------------------------- code
  if (/\b(resend|send again|didn'?t get|not received|dobara|phir se)\b/i.test(message)) {
    const sent = await sendCode({
      email: state.email!,
      scope: `agent:${state.email}`,
      firstName: state.firstName,
      lastName: state.lastName,
      phone: state.phone,
    });
    return {
      result: sent.ok ? askForCode(state, sent.message) : reply(sent.message),
      signedIn: false,
      resume: null,
    };
  }

  const code = CODE_ONLY.exec(message.replace(/[\s-]/g, ''));
  if (!code || !state.email) return null;

  const verified = await verifyCode({
    email: state.email,
    token: code[1],
    scope: `agent:${state.email}`,
  });

  if (!verified.ok) {
    // Keep the question open — a mistyped code is the common case, and
    // dropping the sign-in would mean starting over.
    return {
      result: {
        ...EMPTY,
        message: verified.message,
        outcome: 'clarify',
        pendingAction: park(state, 'Waiting for the emailed code'),
      },
      signedIn: false,
      resume: null,
    };
  }

  // New or returning is decided by what THIS flow did, not by whether a
  // customers row exists. A trigger creates that row as soon as the auth user
  // appears, so by the time the code is verified it is always there — and
  // greeting a first-time customer with "welcome back" is a small lie about
  // knowing them. Having asked for their name is the honest signal: we only do
  // that when the address had no account.
  const isNew = Boolean(state.firstName);
  const name = state.firstName ?? verified.customer.fullName?.split(' ')[0] ?? null;

  const greeting = isNew
    ? name
      ? `You're all set, ${name}.`
      : "You're all set."
    : name
      ? `Welcome back, ${name}.`
      : "You're signed in.";

  return {
    result: reply(greeting, 'answer'),
    signedIn: true,
    resume: state.resume,
  };
}
