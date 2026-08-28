import 'server-only';

import { cookies } from 'next/headers';
import { randomUUID } from 'node:crypto';

import { forbidden, notFound } from '@/lib/api/response';
import { getSessionUser } from '@/lib/auth';
import { adminClient } from '@/lib/supabase/admin';
import {
  emptyRequirements,
  type AssistantMetadata,
  type ConversationMessage,
  type RecommendedProductPayload,
  type ShoppingRequirements,
} from '@/lib/ai/types';

/**
 * Conversation persistence.
 *
 * Same ownership model as carts: signed-in shoppers get rows keyed by
 * customer_id and protected by RLS; guests get an opaque token in an httpOnly
 * cookie. Either way, every read goes through `assertOwnership` before any
 * content is returned — a guessed conversation id gets a 404, not someone
 * else's shopping history.
 */

export const AI_SESSION_COOKIE = 'shopiq_ai';
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

/** How much history the agent is given. Older turns fall out of context. */
export const HISTORY_LIMIT = 12;

export interface ConversationRecord {
  id: string;
  customerId: string | null;
  state: ShoppingRequirements;
  /** Product ids from the most recent assistant turn, for "the first one". */
  lastShownProductIds: string[];
  /**
   * The full payloads behind those ids. Superlative references — "the cheaper
   * one", "the lightest" — need the attributes, not just the identity.
   */
  lastShownProducts: RecommendedProductPayload[];
}

async function sessionToken(create: boolean): Promise<string | null> {
  const store = await cookies();
  const existing = store.get(AI_SESSION_COOKIE)?.value;
  if (existing) return existing;
  if (!create) return null;

  const token = randomUUID();
  store.set(AI_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_MAX_AGE,
  });
  return token;
}

/**
 * Load a conversation the caller owns, or start a new one.
 * Throws 404 when the id exists but belongs to someone else — deliberately
 * indistinguishable from "no such conversation".
 */
export async function openConversation(
  conversationId: string | null,
): Promise<ConversationRecord> {
  const user = await getSessionUser();
  const db = adminClient();

  if (conversationId) {
    const { data } = await db
      .from('conversations')
      .select('id, customer_id, session_token, state, status')
      .eq('id', conversationId)
      .maybeSingle();

    if (!data) throw notFound('Conversation not found.');

    const owned = user
      ? data.customer_id === user.id
      : data.customer_id === null && data.session_token === (await sessionToken(false));

    if (!owned) throw notFound('Conversation not found.');
    if (data.status !== 'active') throw forbidden('This conversation is archived.');

    return {
      id: data.id as string,
      customerId: (data.customer_id as string | null) ?? null,
      state: normaliseState(data.state),
      ...(await lastShown(data.id as string)),
    };
  }

  // A shopper who chatted as a guest and then signed in keeps their history,
  // the same courtesy the cart gets.
  if (user) await claimGuestConversations(user.id);

  const token = user ? null : await sessionToken(true);

  const { data, error } = await db
    .from('conversations')
    .insert({
      customer_id: user?.id ?? null,
      session_token: user ? null : token,
      state: emptyRequirements(),
    })
    .select('id, customer_id, state')
    .single();

  if (error) throw error;

  return {
    id: data.id as string,
    customerId: (data.customer_id as string | null) ?? null,
    state: normaliseState(data.state),
    lastShownProductIds: [],
    lastShownProducts: [],
  };
}

async function lastShown(
  conversationId: string,
): Promise<{ lastShownProductIds: string[]; lastShownProducts: RecommendedProductPayload[] }> {
  const products = await readLastShownProducts(conversationId);
  return {
    lastShownProductIds: products.map((product) => product.productId),
    lastShownProducts: products,
  };
}

/** Requirement state written by an older build may be missing newer fields. */
function normaliseState(raw: unknown): ShoppingRequirements {
  const base = emptyRequirements();
  if (!raw || typeof raw !== 'object') return base;
  const state = raw as Partial<ShoppingRequirements>;

  return {
    category: state.category ?? null,
    categorySlug: state.categorySlug ?? null,
    budget: state.budget ?? base.budget,
    useCases: Array.isArray(state.useCases) ? state.useCases : [],
    preferences: state.preferences ?? {},
    brands: Array.isArray(state.brands) ? state.brands : [],
    specConstraints: Array.isArray(state.specConstraints) ? state.specConstraints : [],
    keywords: Array.isArray(state.keywords) ? state.keywords : [],
    requireInStock: Boolean(state.requireInStock),
    minRating: state.minRating ?? null,
    language: state.language ?? base.language,
  };
}

/**
 * The products the last assistant turn actually displayed.
 *
 * Reads backwards through recent assistant turns rather than only the most
 * recent one: a turn that just confirmed a cart change shows no products, and
 * "add the second one" after it still means the second of the last list the
 * shopper saw.
 */
async function readLastShownProducts(
  conversationId: string,
): Promise<RecommendedProductPayload[]> {
  const { data } = await adminClient()
    .from('conversation_messages')
    .select('metadata')
    .eq('conversation_id', conversationId)
    .eq('role', 'assistant')
    .order('created_at', { ascending: false })
    .limit(5);

  for (const row of data ?? []) {
    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    const products = metadata.products;
    if (Array.isArray(products) && products.length > 0) {
      return products.filter(
        (product): product is RecommendedProductPayload =>
          Boolean(product) &&
          typeof product === 'object' &&
          typeof (product as Record<string, unknown>).productId === 'string',
      );
    }
  }
  return [];
}

export async function loadHistory(
  conversationId: string,
  limit = HISTORY_LIMIT,
): Promise<ConversationMessage[]> {
  const { data, error } = await adminClient()
    .from('conversation_messages')
    .select('id, role, content, metadata, created_at')
    .eq('conversation_id', conversationId)
    .in('role', ['user', 'assistant'])
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;

  return (data ?? [])
    .reverse()
    .map((row) => ({
      id: row.id as string,
      role: row.role as ConversationMessage['role'],
      content: (row.content as string) ?? '',
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      createdAt: row.created_at as string,
    }));
}

export async function appendMessage(
  conversationId: string,
  role: ConversationMessage['role'],
  content: string,
  metadata: AssistantMetadata | Record<string, unknown> = {},
): Promise<string> {
  const { data, error } = await adminClient()
    .from('conversation_messages')
    .insert({ conversation_id: conversationId, role, content, metadata })
    .select('id')
    .single();

  if (error) throw error;
  return data.id as string;
}

export async function saveState(
  conversationId: string,
  state: ShoppingRequirements,
): Promise<void> {
  await adminClient().from('conversations').update({ state }).eq('id', conversationId);
}

/** First user message becomes the conversation title, for the history list. */
export async function ensureTitle(conversationId: string, message: string): Promise<void> {
  const db = adminClient();
  const { data } = await db
    .from('conversations')
    .select('title')
    .eq('id', conversationId)
    .maybeSingle();

  if (data?.title) return;

  const title = message.trim().replace(/\s+/g, ' ').slice(0, 80);
  await db.from('conversations').update({ title: title || 'New conversation' }).eq('id', conversationId);
}

/**
 * When a guest signs in, hand their conversations to the account so the
 * history survives — the same courtesy the cart gets.
 */
export async function claimGuestConversations(customerId: string): Promise<void> {
  const token = await sessionToken(false);
  if (!token) return;

  await adminClient()
    .from('conversations')
    .update({ customer_id: customerId, session_token: null })
    .eq('session_token', token)
    .is('customer_id', null);
}
