import 'server-only';

import type { ProductSummary } from '@/types';
import { vocabulary } from './config';
import type { Recommendation } from './recommend';

/**
 * What the model is allowed to see.
 *
 * A 500-product catalogue in a prompt is not context, it is noise: it costs a
 * fortune, buries the five products that matter, and invites the model to
 * "helpfully" mention a sixth. So retrieval narrows to a handful of candidates
 * first (§59) and this file renders only those, compactly.
 *
 * Every field here is a value read from the database. There is deliberately no
 * field for anything the model might want to add — no marketing copy, no
 * "why you'll love it" — because a slot for prose is an invitation to invent.
 */

export interface CompactProduct {
  id: string;
  name: string;
  brand: string;
  price: number;
  /** MRP, only when it is genuinely higher than the price. */
  mrp?: number;
  availability: number;
  key_specs: Record<string, string | number>;
  rating?: number;
  reviews?: number;
  score?: number;
  reasons?: string[];
  relationship?: string;
}

/**
 * The specs worth showing, by category.
 *
 * Ordered by how much they actually decide a purchase, so a truncated list
 * still leads with the deciding facts rather than whatever the object happened
 * to enumerate first.
 */
const PRIORITY_SPECS: Record<string, string[]> = {
  laptops: ['processor', 'gpu', 'ram_gb', 'storage_gb', 'display_size_in', 'refresh_rate_hz', 'weight_kg'],
  'gaming-laptops': ['gpu', 'processor', 'ram_gb', 'refresh_rate_hz', 'storage_gb', 'weight_kg'],
  phones: ['ram_gb', 'storage_gb', 'camera_mp', 'battery_mah', 'display_size_in', 'refresh_rate_hz'],
  televisions: ['display_size_in', 'resolution', 'refresh_rate_hz', 'hdmi_version', 'panel_type'],
  monitors: ['display_size_in', 'resolution', 'refresh_rate_hz', 'panel_type'],
  ram: ['capacity_gb', 'memory_type', 'form_factor', 'speed_mhz'],
  ssd: ['capacity_gb', 'interface', 'form_factor', 'read_speed_mbps'],
  gpu: ['vram_gb', 'memory_type', 'power_w', 'interface'],
  cpu: ['cores', 'threads', 'socket'],
  earbuds: ['battery_hours', 'connectivity'],
  headphones: ['battery_hours', 'connectivity'],
  controllers: ['connectivity', 'battery_hours'],
  playstation: ['storage_gb', 'resolution'],
};

const GENERIC_SPECS = ['ram_gb', 'storage_gb', 'capacity_gb', 'display_size_in', 'connectivity'];

/**
 * Trim a spec bag down to what decides this purchase.
 *
 * Falls back to the generic list, then to whatever the product has, so a
 * category nobody has curated yet still shows something rather than nothing.
 */
export function keySpecsFor(
  categorySlug: string,
  specs: Record<string, unknown>,
  limit = 5,
): Record<string, string | number> {
  const ordered = PRIORITY_SPECS[categorySlug] ?? GENERIC_SPECS;
  const out: Record<string, string | number> = {};

  const take = (key: string) => {
    if (Object.keys(out).length >= limit) return;
    const value = specs[key];
    if (value === undefined || value === null || value === '') return;
    if (typeof value === 'number' || typeof value === 'string') out[key] = value;
  };

  for (const key of ordered) take(key);

  if (Object.keys(out).length < limit) {
    // Prefer keys the vocabulary knows — an importer's stray field is less
    // likely to mean anything to a shopper than a normalised one.
    const known = Object.keys(specs).filter(
      (key) => key in vocabulary.specifications.numeric || key in vocabulary.specifications.text,
    );
    for (const key of known) take(key);
  }

  return out;
}

/** One product, in the shape the model receives. */
export function toCompact(
  product: ProductSummary,
  extra?: { score?: number; reasons?: string[]; relationship?: string },
): CompactProduct {
  const compact: CompactProduct = {
    id: product.id,
    name: product.name,
    brand: product.brand,
    price: product.price,
    availability: product.availability.available,
    key_specs: keySpecsFor(product.category.slug, (product.specs as Record<string, unknown>) ?? {}),
  };

  // Only a real discount. compare_at_price equal to price is not a saving, and
  // presenting it as one is the oldest trick in retail.
  if (product.compareAtPrice && product.compareAtPrice > product.price) {
    compact.mrp = product.compareAtPrice;
  }
  if (product.reviewCount > 0) {
    compact.rating = product.rating;
    compact.reviews = product.reviewCount;
  }
  if (extra?.score !== undefined) compact.score = extra.score;
  if (extra?.reasons?.length) compact.reasons = extra.reasons;
  if (extra?.relationship) compact.relationship = extra.relationship;

  return compact;
}

/** A recommendation, with its score and reasons attached. */
export function recommendationToCompact(recommendation: Recommendation): CompactProduct {
  return toCompact(recommendation.product, {
    score: recommendation.score,
    reasons: recommendation.reasons,
    relationship: recommendation.relationshipType,
  });
}

/**
 * A whole result set, bounded.
 *
 * The cap is the point: it is what stops a widened search from quietly putting
 * the entire catalogue in front of the model.
 */
export function toCompactList(
  products: ProductSummary[],
  limit = 10,
): CompactProduct[] {
  return products.slice(0, limit).map((product) => toCompact(product));
}
