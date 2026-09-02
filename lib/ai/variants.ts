import 'server-only';

import type { ProductSummary } from '@/types';

/**
 * Product variants.
 *
 * The catalogue models the two axes differently, because the source data does:
 *
 *   - STORAGE is a separate product. "iPhone 17 256 GB" and "iPhone 17 512 GB"
 *     are distinct rows with their own SKU, price and inventory. Choosing one
 *     is choosing a product.
 *   - COLOUR is not. Every colour of a given storage size shares one SKU and
 *     one stock figure. Choosing one is recording a preference against the
 *     line, which is exactly what cart_items.selected_options stores.
 *
 * Both lists are derived from data we hold — names for storage, uploaded image
 * keys for colour. Neither is a hardcoded table of what Apple sells, so the
 * assistant can only ever offer a variant that actually exists in ShopiQ.
 */

/** "iPhone 17 512 GB" -> captures "512" and "GB". Anchored to the end. */
const STORAGE_SUFFIX = /\s+(\d+(?:\.\d+)?)\s*(GB|TB)\s*$/i;

/** The family a variant belongs to: the name minus its storage size. */
export function variantBase(name: string): string {
  return name.replace(STORAGE_SUFFIX, '').trim();
}

/** The storage size a product name declares, normalised for display. */
export function storageLabel(name: string): string | null {
  const match = STORAGE_SUFFIX.exec(name);
  return match ? `${match[1]} ${match[2].toUpperCase()}` : null;
}

/**
 * Group products that differ only by storage size.
 *
 * Keyed by family name; single-member families are kept, so callers can ask
 * "is there a choice here?" with one lookup.
 */
export function groupVariants(products: ProductSummary[]): Map<string, ProductSummary[]> {
  const groups = new Map<string, ProductSummary[]>();
  for (const product of products) {
    const key = `${product.brand}|${variantBase(product.name)}`;
    const existing = groups.get(key);
    if (existing) existing.push(product);
    else groups.set(key, [product]);
  }
  // Cheapest first: the storage ladder is what the shopper is choosing along.
  for (const group of groups.values()) group.sort((a, b) => a.price - b.price);
  return groups;
}

/**
 * Did the shopper already pin down a storage size?
 *
 * Matches the way people actually write it — "256", "256gb", "256 GB", "1tb",
 * "1 TB" — so that "add the iPhone 17 512GB" is taken as a decision rather than
 * being met with a question they have already answered.
 */
export interface StorageOption {
  id: string;
  /** "512 GB", "1 TB" — already normalised for display and matching. */
  label: string;
}

export function statedStorage(message: string, options: StorageOption[]): string | null {
  const lower = message.toLowerCase();

  // Size plus unit first — but only when one option carries that label. Two
  // different phones can both be offered at 256 GB, and picking whichever came
  // back first would silently hand the shopper the other model.
  for (const option of options) {
    const [size, unit] = option.label.split(' ');
    if (!size || !unit) continue;
    const sameLabel = options.filter((other) => other.label === option.label);
    if (sameLabel.length !== 1) continue;
    if (new RegExp(`\\b${size}\\s*${unit}\\b`, 'i').test(lower)) return option.id;
  }

  // A bare number is only safe when it cannot mean anything else in this set:
  // "512" is fine when one option is 512 GB, but "1" must not silently pick
  // 1 TB over 128 GB.
  for (const option of options) {
    const size = option.label.split(' ')[0];
    if (!size) continue;
    const collisions = options.filter((other) => other.label.split(' ')[0] === size);
    if (collisions.length !== 1) continue;
    if (new RegExp(`\\b${size}\\b`).test(lower)) return option.id;
  }

  return null;
}

/** Storage options for a set of products, dropping any without a size. */
export function storageOptionsOf(products: ProductSummary[]): StorageOption[] {
  const options: StorageOption[] = [];
  for (const product of products) {
    const label = storageLabel(product.name);
    if (label) options.push({ id: product.id, label });
  }
  return options;
}

/* ------------------------------------------------------------------ colour */

/**
 * The colour words the catalogue actually uses, in one place.
 *
 * Two jobs: deciding whether an image filename names a colour at all, and
 * recognising a colour in a shopper's reply. Those were separate lists, which
 * is how "Shopping" came to be offered as a colour — one list knew what a
 * colour looks like and the other did not.
 */
export const COLOUR_WORDS =
  /\b(black|white|blue|green|red|pink|purple|violet|orange|yellow|grey|gray|silver|gold|teal|sage|lavender|mist|cream|beige|bronze|copper|titanium|graphite|midnight|starlight|ultramarine|cobalt|natural|desert|space|charcoal|ivory|navy|olive|mint|peach|rose|amber|sand|slate|platinum|pearl|onyx|aqua|cyan|magenta|maroon|burgundy|khaki|plum|indigo|jade|emerald|sapphire|coral|lime|azure|carbon|chrome|sky|forest|ocean|cloud|storm|shadow|arctic|glacier|frost|lilac|mauve)\b/i;

/**
 * The colours a product is offered in, read from its uploaded images.
 *
 * The source folders name these three ways — "Color - Pink.webp",
 * "Colour - Sage.webp" and a bare "Cosmic Orange.webp" — which the seeder
 * slugifies into the image key. Every non-base image is a colour shot, so the
 * key list is the colour list, and it cannot drift from what we can actually
 * show the customer.
 */
export function coloursFromImageKeys(keys: string[]): string[] {
  const colours: string[] = [];
  const seen = new Set<string>();

  for (const key of keys) {
    // These arrive as URLs, so "Titanium%20Gray.webp" must be decoded before it
    // can be read as two words rather than one unreadable token.
    const raw = key.split('/').pop() ?? '';
    let file = raw;
    try {
      file = decodeURIComponent(raw);
    } catch {
      // A malformed escape is not worth throwing over; use it as it came.
    }
    const stem = file.replace(/\.[^.]+$/, '');
    if (!stem || stem.toLowerCase().startsWith('base')) continue;

    // A key is only a colour if it READS like one. The seeded folders name
    // colours explicitly, but reused CDN assets carry opaque filenames like
    // "262565_0_cMTz4dVUv" — and treating those as colours made the
    // assistant ask "comes in 1 colours: 262565_0_cMTz4dVUv. Which would you
    // like?". An unreadable name is not a choice we can offer.
    const declared = /^colou?r[-_ ]/i.test(stem);
    const cleaned = stem
      .replace(/^colou?r[-_ ]/i, '')
      .replace(/[-_]+/g, ' ')
      .trim();
    if (!cleaned) continue;

    // Words only, and no more than three of them: "Sage", "Cosmic Orange",
    // "Titanium Gray" pass; anything carrying digits or gibberish does not.
    const words = cleaned.split(/\s+/);
    const readable =
      words.length <= 3 && words.every((word) => /^[A-Za-z]{3,}$/.test(word));

    // Reading like a word is not the same as naming a colour. The reused CDN
    // assets include "images.webp" and "shopping.webp", which are perfectly
    // pronounceable and produced "Added the Apple 20W Power Adapter in
    // Shopping to your cart". An undeclared name has to contain an actual
    // colour to count as one.
    if (!declared && !(readable && COLOUR_WORDS.test(cleaned))) continue;

    const label = cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
    const identity = label.toLowerCase();
    if (seen.has(identity)) continue;
    seen.add(identity);
    colours.push(label);
  }

  return colours;
}

/** Which of the offered colours did the shopper name, if any? */
export function statedColour(message: string, colours: string[]): string | null {
  const lower = message.toLowerCase();

  // Longest first, so "Titanium Black" wins over "Black" when both are offered.
  const ordered = [...colours].sort((a, b) => b.length - a.length);
  for (const colour of ordered) {
    if (lower.includes(colour.toLowerCase())) return colour;
  }

  // A one-word answer to "which colour?" — "sage", "white".
  const trimmed = lower.trim().replace(/[.!?]+$/, '');
  for (const colour of ordered) {
    if (colour.toLowerCase() === trimmed) return colour;
  }

  return null;
}

/** "Sage" -> " (Sage)", for appending to a product name in a sentence. */
export function describeOptions(options: Record<string, unknown> | null | undefined): string {
  if (!options) return '';
  const values = Object.values(options).filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  return values.length > 0 ? ` (${values.join(', ')})` : '';
}
