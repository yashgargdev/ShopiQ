import 'server-only';

import { formatPrice } from '@/lib/format';
import { getProductDetail } from '@/lib/products/queries';
import type { ProductSummary } from '@/types';

import { buildPendingAction, type PendingAction } from './confirm';
import { searchProductSummaries } from './tools/implementations';
import {
  coloursFromImageKeys,
  groupVariants,
  statedColour,
  statedStorage,
  storageLabel,
  storageOptionsOf,
  variantBase,
  type StorageOption,
} from './variants';

/**
 * Choosing a variant, as a conversation.
 *
 * "Add an iPhone 17" is not yet an instruction a cart can execute: there are
 * two storage sizes at different prices, and five colours. Guessing would put
 * a ₹1,02,900 phone in someone's cart when they meant the ₹82,900 one.
 *
 * So the add is parked and the missing axis is asked for, one at a time, using
 * the pending-action slot that already exists for confirmations. Every option
 * offered is read from the catalogue at the moment of asking — the storage
 * sizes are real products, the colours are real uploaded images — so the
 * assistant cannot offer a variant ShopiQ does not have.
 */

export const SELECT_VARIANT = 'select_variant';

export interface VariantSelection {
  stage: 'storage' | 'colour';
  /**
   * The storage sizes offered, with the product each one resolves to.
   *
   * Stored on the pending action rather than re-derived on the next turn, so
   * the answer is matched against exactly what the shopper was shown even if
   * the catalogue changes in between.
   */
  options: StorageOption[];
  /** The chosen product, once storage is settled. */
  productId: string | null;
  quantity: number;
  /** Colours offered at the time of asking. */
  colours: string[];
}

function selection(args: Record<string, unknown>): VariantSelection | null {
  const stage = args.stage;
  if (stage !== 'storage' && stage !== 'colour') return null;
  return {
    stage,
    options: Array.isArray(args.options) ? (args.options as StorageOption[]) : [],
    productId: typeof args.productId === 'string' ? args.productId : null,
    quantity: typeof args.quantity === 'number' ? args.quantity : 1,
    colours: Array.isArray(args.colours) ? (args.colours as string[]) : [],
  };
}

export function readVariantSelection(action: PendingAction | null): VariantSelection | null {
  if (!action || action.action !== SELECT_VARIANT) return null;
  return selection(action.arguments);
}

function park(state: VariantSelection, summary: string): PendingAction {
  return buildPendingAction(SELECT_VARIANT, { ...state }, summary);
}

/* --------------------------------------------------------------- questions */

export interface VariantQuestion {
  message: string;
  pending: PendingAction;
}

/** Ask which storage size, listing the real ones with their real prices. */
export function askStorage(options: ProductSummary[], quantity: number): VariantQuestion {
  const family = variantBase(options[0].name);
  const lines = options
    .map((product) => `· ${storageLabel(product.name) ?? product.name} — ${formatPrice(product.price)}`)
    .join('\n');

  return {
    message: `The ${family} comes in a few sizes. Which one would you like?\n${lines}`,
    pending: park(
      {
        stage: 'storage',
        options: storageOptionsOf(options),
        productId: null,
        quantity,
        colours: [],
      },
      `Choosing a storage size for the ${family}`,
    ),
  };
}

/** Ask which colour, listing only colours we hold images for. */
export function askColour(
  product: { id: string; name: string },
  colours: string[],
  quantity: number,
): VariantQuestion {
  return {
    message: `The ${product.name} comes in ${colours.length} colours: ${colours.join(', ')}. Which would you like? Say "any" if you don't mind.`,
    pending: park(
      {
        stage: 'colour',
        options: [],
        productId: product.id,
        quantity,
        colours,
      },
      `Choosing a colour for the ${product.name}`,
    ),
  };
}

/* ----------------------------------------------------------------- lookups */

/** The colours a product is offered in, read from its uploaded images. */
export async function coloursFor(productId: string): Promise<string[]> {
  try {
    const detail = await getProductDetail(productId);
    return coloursFromImageKeys(detail.images.map((image) => image.url));
  } catch {
    // A missing product is handled by the add itself, which fails loudly.
    return [];
  }
}

/**
 * Find the products a shopper's phrase names, when it did not resolve to
 * something already on screen.
 *
 * "add an iPhone 17" arrives with nothing shown, so there is no reference to
 * resolve; searching is what turns it into a real set of candidates instead of
 * a dead end.
 */
export async function findByPhrase(message: string): Promise<ProductSummary[]> {
  const phrase = message
    .toLowerCase()
    .replace(
      /\b(add|put|cart|mein|me|my|to|the|a|an|one|please|karo|daal|daalo|dedo|chahiye|buy|order|i|want|would|like)\b/g,
      ' ',
    )
    .replace(/[^a-z0-9\s.+-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (phrase.length < 3) return [];

  try {
    const result = await searchProductSummaries({
      query: phrase,
      category: null,
      brand: null,
      min_price: null,
      max_price: null,
      min_rating: null,
      filters: null,
      in_stock_only: true,
      sort: 'relevance',
      limit: 20,
    });
    return result.products;
  } catch {
    return [];
  }
}

/**
 * Decide what still needs asking before this product can go in the cart.
 *
 * Returns a question, or null when everything needed is already known.
 */
export async function nextQuestionFor(
  product: ProductSummary,
  message: string,
  quantity: number,
): Promise<{ question: VariantQuestion | null; colour: string | null }> {
  const colours = await coloursFor(product.id);
  if (colours.length === 0) return { question: null, colour: null };

  const stated = statedColour(message, colours);
  if (stated) return { question: null, colour: stated };

  return { question: askColour(product, colours, quantity), colour: null };
}

/**
 * Given the candidates a phrase matched, work out whether we can proceed.
 *
 * A single family with several storage sizes is a question about storage. One
 * product is an answer. Several unrelated products means the phrase was too
 * vague to act on at all.
 */
export function narrow(
  candidates: ProductSummary[],
  message: string,
): { product: ProductSummary | null; options: ProductSummary[] | null } {
  if (candidates.length === 0) return { product: null, options: null };
  if (candidates.length === 1) return { product: candidates[0], options: null };

  const groups = [...groupVariants(candidates).values()];

  // Prefer the family whose base name the shopper actually typed: "iPhone 17"
  // must not be answered with iPhone 17 Pro sizes just because they matched.
  const lower = message.toLowerCase();
  const named = groups.filter((group) => lower.includes(variantBase(group[0].name).toLowerCase()));
  const exact = named.length > 0 ? named : groups;

  // The most specific family the shopper named wins, so "iPhone 17 Pro" beats
  // the shorter "iPhone 17" that is a prefix of it.
  exact.sort((a, b) => variantBase(b[0].name).length - variantBase(a[0].name).length);
  const group = exact[0];

  if (!group) return { product: null, options: null };

  const alreadyChosen = statedStorage(message, storageOptionsOf(group));
  if (alreadyChosen) {
    const picked = group.find((product) => product.id === alreadyChosen);
    if (picked) return { product: picked, options: null };
  }

  if (group.length === 1) return { product: group[0], options: null };
  return { product: null, options: group };
}

/** "any colour is fine" — proceed without recording one. */
export function saysNoPreference(message: string): boolean {
  return /\b(any|anything|whatever|koi bhi|kuch bhi|jo bhi|does ?n.?t matter|no preference|surprise me|aapki marzi|tum decide)\b/i.test(
    message,
  );
}

export { statedColour, statedStorage };
