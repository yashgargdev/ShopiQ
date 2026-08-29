import 'server-only';

import fs from 'node:fs';
import path from 'node:path';

import taxonomyJson from '@/data/catalog/taxonomy.json';
import vocabularyJson from '@/data/catalog/vocabulary.json';
import rankingJson from '@/data/catalog/ranking.json';
import recommendationsJson from '@/data/catalog/recommendations.json';

/**
 * The catalogue knowledge layer, loaded once.
 *
 * These files are the contract between three things that must agree: the
 * products an import creates, the rules that decide what goes with what, and
 * the extractor that turns "gaming laptop under 80k" into a query. When they
 * disagree the failure is silent — a product tagged with a segment no rule
 * names is simply never recommended, and nothing reports it — which is why
 * `validateCatalogConfig()` exists and why it runs in the tests.
 *
 * Imported statically rather than read at request time so the bundler resolves
 * them and a malformed file fails the build instead of the first customer.
 */

export interface TaxonomyNode {
  slug: string;
  name: string;
  parent: string | null;
}

export const taxonomy = taxonomyJson as {
  version: string;
  root: string;
  nodes: TaxonomyNode[];
  aliases: Record<string, string[]>;
};

export const vocabulary = vocabularyJson as {
  version: string;
  segments: Record<string, string[]>;
  use_cases: { values: string[] };
  performance: { scale: { min: number; max: number }; dimensions: string[] };
  specifications: {
    numeric: Record<string, { unit: string; note?: string }>;
    text: Record<string, { enum?: string[]; note?: string }>;
  };
  specification_groups: Record<string, Record<string, string[]>>;
  relationship_types: { values: string[] };
  compatibility_predicates: { values: string[] };
  accessory_types: Record<string, string>;
};

export const ranking = rankingJson as {
  version: string;
  default_profile: string;
  profiles: Record<
    string,
    { weights: Record<string, number>; diversity?: { max_per_brand: number } }
  >;
  guardrails: { max_single_signal_share: number; hard_filters_never_scored: string[] };
};

export const recommendations = recommendationsJson as {
  version: string;
  settings: Record<string, { value: number } | { max_per_brand: number }>;
  rules: RecommendationRule[];
  brand_ecosystems: Record<string, { boost: number; categories: string[] }>;
};

/* ------------------------------------------------------------------- rules */

/** A comparison, as written in recommendations.json. */
export type Condition =
  | string
  | number
  | boolean
  | Partial<Record<Operator, unknown>>;

export type Operator =
  | 'equals'
  | 'not_equals'
  | 'greater_than'
  | 'greater_than_or_equal'
  | 'less_than'
  | 'less_than_or_equal'
  | 'contains'
  | 'in'
  | 'not_in'
  | 'exists';

export const OPERATORS: Operator[] = [
  'equals',
  'not_equals',
  'greater_than',
  'greater_than_or_equal',
  'less_than',
  'less_than_or_equal',
  'contains',
  'in',
  'not_in',
  'exists',
];

export interface RecommendationTarget {
  category: string;
  type: string;
  priority: number;
  reason: string;
  /** Extra conditions the CANDIDATE must satisfy, not the anchor. */
  require?: Record<string, Condition>;
}

export interface RecommendationRule {
  id: string;
  when: Record<string, Condition>;
  recommend: RecommendationTarget[];
}

/* --------------------------------------------------------------- accessors */

const nodeBySlug = new Map(taxonomy.nodes.map((node) => [node.slug, node]));

export function categoryExists(slug: string): boolean {
  return nodeBySlug.has(slug);
}

/** A category and everything beneath it, for "laptops" to include gaming ones. */
export function categoryWithDescendants(slug: string): string[] {
  const out = [slug];
  for (let i = 0; i < out.length; i += 1) {
    for (const node of taxonomy.nodes) {
      if (node.parent === out[i] && !out.includes(node.slug)) out.push(node.slug);
    }
  }
  return out;
}

/** Walk up to the root, so a rule on `laptops` also matches `gaming-laptops`. */
export function categoryAncestors(slug: string): string[] {
  const out: string[] = [];
  let current = nodeBySlug.get(slug)?.parent ?? null;
  while (current) {
    out.push(current);
    current = nodeBySlug.get(current)?.parent ?? null;
  }
  return out;
}

export function settingValue(key: string, fallback: number): number {
  const entry = recommendations.settings[key] as { value?: number } | undefined;
  return typeof entry?.value === 'number' ? entry.value : fallback;
}

export function rankingProfile(name?: string): Record<string, number> {
  const profile = ranking.profiles[name ?? ranking.default_profile];
  return profile?.weights ?? ranking.profiles[ranking.default_profile].weights;
}

/* -------------------------------------------------------------- validation */

export interface ConfigProblem {
  file: string;
  problem: string;
}

/**
 * Check the four files agree with each other.
 *
 * Every problem found here is one that would otherwise cause a product to be
 * quietly unreachable rather than to fail. Run by `npm run test:catalog`.
 */
export function validateCatalogConfig(): ConfigProblem[] {
  const problems: ConfigProblem[] = [];

  // -- taxonomy ------------------------------------------------------------
  const slugs = new Set<string>();
  for (const node of taxonomy.nodes) {
    if (slugs.has(node.slug)) {
      problems.push({ file: 'taxonomy.json', problem: `duplicate slug "${node.slug}"` });
    }
    slugs.add(node.slug);
  }
  for (const node of taxonomy.nodes) {
    if (node.parent && !slugs.has(node.parent)) {
      problems.push({
        file: 'taxonomy.json',
        problem: `"${node.slug}" has parent "${node.parent}", which is not a node`,
      });
    }
  }
  for (const [slug, aliases] of Object.entries(taxonomy.aliases)) {
    if (!slugs.has(slug)) {
      problems.push({ file: 'taxonomy.json', problem: `aliases name unknown category "${slug}"` });
    }
    if (aliases.length === 0) {
      problems.push({ file: 'taxonomy.json', problem: `"${slug}" has an empty alias list` });
    }
  }

  // -- vocabulary ----------------------------------------------------------
  for (const category of Object.keys(vocabulary.segments)) {
    if (!slugs.has(category)) {
      problems.push({
        file: 'vocabulary.json',
        problem: `segments defined for unknown category "${category}"`,
      });
    }
  }
  for (const [category, groups] of Object.entries(vocabulary.specification_groups)) {
    if (!slugs.has(category)) {
      problems.push({
        file: 'vocabulary.json',
        problem: `specification_groups for unknown category "${category}"`,
      });
    }
    for (const keys of Object.values(groups)) {
      for (const key of keys) {
        const known =
          key in vocabulary.specifications.numeric || key in vocabulary.specifications.text;
        // Not fatal — a group may name a spec no product carries yet — but it
        // is worth surfacing, because the usual cause is a typo.
        if (!known) {
          problems.push({
            file: 'vocabulary.json',
            problem: `spec group "${category}" names "${key}", which is in neither numeric nor text specifications`,
          });
        }
      }
    }
  }
  for (const slug of Object.values(vocabulary.accessory_types)) {
    if (!slugs.has(slug)) {
      problems.push({
        file: 'vocabulary.json',
        problem: `accessory_types maps to unknown category "${slug}"`,
      });
    }
  }

  // -- recommendations -----------------------------------------------------
  const ruleIds = new Set<string>();
  for (const rule of recommendations.rules) {
    if (ruleIds.has(rule.id)) {
      problems.push({ file: 'recommendations.json', problem: `duplicate rule id "${rule.id}"` });
    }
    ruleIds.add(rule.id);

    for (const target of rule.recommend) {
      if (!slugs.has(target.category)) {
        problems.push({
          file: 'recommendations.json',
          problem: `rule "${rule.id}" recommends unknown category "${target.category}"`,
        });
      }
      if (!vocabulary.relationship_types.values.includes(target.type)) {
        problems.push({
          file: 'recommendations.json',
          problem: `rule "${rule.id}" uses unknown relationship type "${target.type}"`,
        });
      }
      if (!target.reason || target.reason.length < 8) {
        // Section 56: every recommendation carries a reason. A rule with no
        // usable reason produces a suggestion nobody can justify.
        problems.push({
          file: 'recommendations.json',
          problem: `rule "${rule.id}" -> "${target.category}" has no usable reason`,
        });
      }
    }
  }
  for (const [brand, ecosystem] of Object.entries(recommendations.brand_ecosystems)) {
    for (const category of ecosystem.categories) {
      if (!slugs.has(category)) {
        problems.push({
          file: 'recommendations.json',
          problem: `brand ecosystem "${brand}" names unknown category "${category}"`,
        });
      }
    }
  }

  // -- ranking -------------------------------------------------------------
  if (!ranking.profiles[ranking.default_profile]) {
    problems.push({
      file: 'ranking.json',
      problem: `default_profile "${ranking.default_profile}" is not a profile`,
    });
  }
  for (const [name, profile] of Object.entries(ranking.profiles)) {
    const total = Object.values(profile.weights).reduce((sum, value) => sum + value, 0);
    if (total <= 0) {
      problems.push({ file: 'ranking.json', problem: `profile "${name}" has no weight` });
      continue;
    }
    for (const [signal, weight] of Object.entries(profile.weights)) {
      if (weight / total > ranking.guardrails.max_single_signal_share) {
        problems.push({
          file: 'ranking.json',
          problem: `profile "${name}": "${signal}" is ${Math.round((weight / total) * 100)}% of the total, over the ${Math.round(ranking.guardrails.max_single_signal_share * 100)}% guardrail`,
        });
      }
    }
  }

  return problems;
}

/**
 * Confirm the schema file on disk is valid JSON and describes what we expect.
 *
 * Kept separate because schema.json is a contract for a future import rather
 * than something the running code reads.
 */
export function validateSchemaFile(): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const file = path.join(process.cwd(), 'data', 'catalog', 'schema.json');

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return [{ file: 'schema.json', problem: `unreadable: ${(error as Error).message}` }];
  }

  const defs = (parsed.$defs as Record<string, { properties?: Record<string, unknown> }>) ?? {};
  const product = defs.product?.properties ?? {};

  for (const required of [
    'product_family',
    'configuration',
    'segments',
    'use_cases',
    'performance',
    'specifications',
    'compatibility',
    'relationships',
    'recommendation_profile',
  ]) {
    if (!(required in product)) {
      problems.push({ file: 'schema.json', problem: `product is missing "${required}"` });
    }
  }

  return problems;
}
