import 'server-only';

import { categoryExists, vocabulary } from './config';

/**
 * Validate a catalogue dataset before it reaches the database.
 *
 * Every check here guards a failure that is SILENT rather than loud. A product
 * in a category no rule names is never recommended; a segment misspelt by one
 * character matches nothing; a numeric spec stored as "16 GB" drops the product
 * from every range filter. None of those raise an error at runtime — they just
 * make a product invisible, and nobody notices until a demo goes quiet.
 *
 * So the import refuses to run on `error`, and reports `warning` for things
 * that are suspicious but legitimate.
 */

export interface CatalogProblem {
  level: 'error' | 'warning';
  product?: string;
  problem: string;
}

interface CatalogProduct {
  id?: string;
  product_family?: string;
  name?: string;
  brand?: string;
  category?: string;
  segments?: string[];
  use_cases?: string[];
  configuration?: Record<string, unknown>;
  pricing?: { mrp?: number; selling_price?: number; currency?: string };
  sku?: string;
  inventory?: { quantity?: number };
  specifications?: Record<string, unknown>;
  performance?: Record<string, number>;
  images?: Array<{ url?: string; is_primary?: boolean }>;
  tags?: string[];
}

export interface CatalogFile {
  catalog_version?: string;
  demo_dataset?: boolean;
  products?: CatalogProduct[];
}

/** Only the ShopiQ CDN. An invented or scraped URL must not reach the DB. */
const ALLOWED_IMAGE_HOST = 'cdn.shopiq.yashgarg.co.in';

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function validateCatalogData(catalog: CatalogFile): CatalogProblem[] {
  const problems: CatalogProblem[] = [];
  const products = catalog.products ?? [];

  if (!catalog.catalog_version || !/^\d+\.\d+\.\d+/.test(catalog.catalog_version)) {
    problems.push({ level: 'error', problem: 'catalog_version must be semver' });
  }
  if (products.length === 0) {
    problems.push({ level: 'error', problem: 'the catalogue is empty' });
    return problems;
  }

  const ids = new Set<string>();
  const skus = new Set<string>();
  const families = new Map<string, Set<string>>();

  for (const product of products) {
    const label = product.id ?? product.sku ?? product.name ?? '(unnamed)';
    const fail = (problem: string) =>
      problems.push({ level: 'error', product: label, problem });
    const warn = (problem: string) =>
      problems.push({ level: 'warning', product: label, problem });

    // -- identity ---------------------------------------------------------
    if (!product.id || !SLUG.test(product.id)) {
      fail('id must be a lower-case slug');
    } else if (ids.has(product.id)) {
      fail('duplicate id');
    } else {
      ids.add(product.id);
    }

    if (!product.sku) {
      fail('sku is required');
    } else if (skus.has(product.sku)) {
      // A duplicate SKU makes the import non-idempotent: the second row
      // overwrites the first and one product silently disappears.
      fail(`duplicate sku "${product.sku}"`);
    } else {
      skus.add(product.sku);
    }

    if (!product.name) fail('name is required');
    if (!product.brand) fail('brand is required');

    // -- taxonomy ---------------------------------------------------------
    if (!product.category) {
      fail('category is required');
    } else if (!categoryExists(product.category)) {
      fail(`unknown category "${product.category}"`);
    }

    if (product.product_family && !SLUG.test(product.product_family)) {
      fail('product_family must be a lower-case slug');
    }
    if (product.product_family) {
      const members = families.get(product.product_family) ?? new Set<string>();
      if (product.category) members.add(product.category);
      families.set(product.product_family, members);
    }

    // -- vocabulary -------------------------------------------------------
    const allowedSegments = product.category
      ? (vocabulary.segments[product.category] ?? [])
      : [];
    for (const segment of product.segments ?? []) {
      if (allowedSegments.length > 0 && !allowedSegments.includes(segment)) {
        fail(`segment "${segment}" is not valid for ${product.category}`);
      }
    }
    for (const useCase of product.use_cases ?? []) {
      if (!vocabulary.use_cases.values.includes(useCase)) {
        fail(`unknown use case "${useCase}"`);
      }
    }

    // -- pricing ----------------------------------------------------------
    const price = product.pricing?.selling_price;
    const mrp = product.pricing?.mrp;
    if (typeof price !== 'number' || price <= 0) {
      fail('selling_price must be a positive number');
    }
    if (typeof mrp === 'number' && typeof price === 'number' && mrp < price) {
      // A "discount" that is not one. The database enforces this too; catching
      // it here names the product instead of failing an opaque constraint.
      fail(`mrp ${mrp} is below selling_price ${price}`);
    }
    if (product.pricing?.currency && product.pricing.currency !== 'INR') {
      warn(`currency ${product.pricing.currency} — the store prices in INR`);
    }

    // -- inventory --------------------------------------------------------
    const quantity = product.inventory?.quantity;
    if (typeof quantity !== 'number' || quantity < 0 || !Number.isInteger(quantity)) {
      fail('inventory.quantity must be a non-negative integer');
    }

    // -- specifications ---------------------------------------------------
    for (const [key, value] of Object.entries(product.specifications ?? {})) {
      const isNumericKey = key in vocabulary.specifications.numeric;
      const isTextKey = key in vocabulary.specifications.text;

      if (!isNumericKey && !isTextKey) {
        // Not fatal: a category may legitimately need a key nobody has
        // declared yet. But it will not be filterable, so say so.
        warn(`spec "${key}" is not in the vocabulary — it will not be filterable`);
        continue;
      }
      if (isNumericKey && typeof value !== 'number') {
        fail(`spec "${key}" must be a number, got ${JSON.stringify(value)}`);
      }
      const enumValues = vocabulary.specifications.text[key]?.enum;
      if (isTextKey && enumValues && typeof value === 'string' && !enumValues.includes(value)) {
        warn(`spec "${key}" value "${value}" is outside the declared enum`);
      }
    }

    // -- performance ------------------------------------------------------
    for (const [dimension, score] of Object.entries(product.performance ?? {})) {
      if (!vocabulary.performance.dimensions.includes(dimension)) {
        fail(`unknown performance dimension "${dimension}"`);
      }
      if (!Number.isInteger(score) || score < 1 || score > 10) {
        fail(`performance "${dimension}" must be an integer 1-10, got ${score}`);
      }
    }

    // -- images -----------------------------------------------------------
    const images = product.images ?? [];
    if (images.length === 0) {
      warn('no image — the product will render as a placeholder');
    }
    for (const image of images) {
      if (!image.url) {
        fail('an image has no url');
        continue;
      }
      let host: string;
      try {
        host = new URL(image.url).hostname;
      } catch {
        fail(`image url is not a URL: ${image.url}`);
        continue;
      }
      if (host !== ALLOWED_IMAGE_HOST) {
        // The rule is not stylistic. An invented URL 404s and looks like a
        // bug; a scraped one is someone else's asset on someone else's terms.
        fail(`image host "${host}" is not the ShopiQ CDN`);
      }
    }
    if (images.length > 0 && !images.some((image) => image.is_primary)) {
      warn('no primary image — the first will be used');
    }
    if (images.filter((image) => image.is_primary).length > 1) {
      fail('more than one primary image');
    }
  }

  // -- families ------------------------------------------------------------
  for (const [family, categories] of families) {
    if (categories.size > 1) {
      // A family spanning categories breaks "show me the 1 TB version": the
      // sibling lookup would cross from a laptop into a monitor.
      problems.push({
        level: 'error',
        problem: `product_family "${family}" spans several categories: ${[...categories].join(', ')}`,
      });
    }
  }

  return problems;
}

export function summarise(problems: CatalogProblem[]): {
  errors: CatalogProblem[];
  warnings: CatalogProblem[];
} {
  return {
    errors: problems.filter((problem) => problem.level === 'error'),
    warnings: problems.filter((problem) => problem.level === 'warning'),
  };
}
