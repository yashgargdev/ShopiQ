/**
 * Demo reviews for every active product.
 *
 *   node -r dotenv/config scripts/seed-reviews.mjs dotenv_config_path=.env.local
 *
 * DEMO DATA. These are invented so the assistant has something to analyse and
 * so the rating filter has something to filter on. They are labelled as demo
 * reviews everywhere they are shown, because presenting fabricated praise as
 * real customer feedback is exactly the thing a shopping assistant must not do.
 *
 * Two properties matter more than volume:
 *
 *   1. They disagree. A catalogue where everything is 4.8 stars carries no
 *      information — "what do reviews say?" can only be answered usefully if
 *      some products are genuinely worse, and if the complaints are specific.
 *   2. Each review declares which ASPECTS it speaks to. The summary the
 *      assistant reads is then computed from those labels rather than inferred
 *      from prose, so "buyers complain about battery" is a count, not a guess.
 *
 * Deterministic: the same product always produces the same reviews, so
 * re-running does not churn ratings. Existing reviews for a product are
 * replaced, never duplicated.
 */
import { createClient } from '@supabase/supabase-js';

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/* ------------------------------------------------------ deterministic noise */

/** FNV-1a, so a product's reviews depend only on its SKU. */
function seedOf(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const pick = (random, list) => list[Math.floor(random() * list.length)];

/* ------------------------------------------------------------------ people */

const FIRST = [
  'Aarav', 'Vivaan', 'Aditya', 'Ananya', 'Diya', 'Ishaan', 'Kabir', 'Meera',
  'Rohan', 'Saanvi', 'Arjun', 'Neha', 'Priya', 'Rahul', 'Sneha', 'Karthik',
  'Fatima', 'Zoya', 'Devansh', 'Tanvi', 'Harsh', 'Nikhil', 'Pooja', 'Riya',
];
const LAST = [
  'Sharma', 'Verma', 'Patel', 'Reddy', 'Nair', 'Iyer', 'Singh', 'Gupta',
  'Mehta', 'Khan', 'Das', 'Bose', 'Chauhan', 'Joshi', 'Kulkarni', 'Rao',
];

const author = (random) => `${pick(random, FIRST)} ${pick(random, LAST)[0]}.`;

/* ----------------------------------------------------------------- opinions */

/**
 * What people talk about, per category family, and how they say it.
 *
 * Positive and negative lines for the same aspect, so a product can be praised
 * for its screen and criticised for its battery in one review set — which is
 * what real ones look like.
 */
const ASPECTS = {
  phone: {
    battery: {
      good: ['easily lasts a full day with heavy use', 'battery still at 40% by bedtime'],
      bad: ['battery drains faster than I expected with the screen at full brightness', 'needs a top-up by evening on heavy days'],
    },
    camera: {
      good: ['photos in daylight are genuinely excellent', 'night mode holds detail far better than my old phone'],
      bad: ['low-light shots come out softer than the samples suggested', 'the zoom past 5x is not usable'],
    },
    display: {
      good: ['the screen is bright enough to read outdoors', 'scrolling feels noticeably smoother at 120Hz'],
      bad: ['brightness struggles in direct sunlight'],
    },
    performance: {
      good: ['no stutter at all, even with a dozen apps open', 'games run without the phone getting hot'],
      bad: ['it warms up during long gaming sessions'],
    },
    value: {
      good: ['hard to beat at this price', 'felt like good value the moment I set it up'],
      bad: ['a little expensive for what you get'],
    },
  },
  laptop: {
    performance: {
      good: ['compiles and builds noticeably faster than my old machine', 'handles a heavy IDE and a browser full of tabs without complaint'],
      bad: ['thermal throttling shows up on long builds'],
    },
    battery: {
      good: ['a full working day away from a socket', 'battery life is the reason I would buy it again'],
      bad: ['battery drops quickly once you push the GPU', 'you will want the charger nearby'],
    },
    display: {
      good: ['the panel is crisp and colours look right out of the box'],
      bad: ['the screen is dimmer than I would like for outdoor work'],
    },
    build: {
      good: ['feels solid, no flex in the keyboard deck'],
      bad: ['picks up fingerprints instantly', 'heavier than the spec sheet made it sound'],
    },
    keyboard: {
      good: ['comfortable keyboard for long typing sessions'],
      bad: ['the trackpad is only adequate'],
    },
    value: {
      good: ['very good value for the specification'],
      bad: ['you pay a premium for the brand'],
    },
  },
  audio: {
    sound: {
      good: ['clear sound with bass that does not drown the vocals', 'noticeably better than the pair these replaced'],
      bad: ['bass is heavier than I like and cannot be tuned down much'],
    },
    comfort: {
      good: ['comfortable for hours, no ear fatigue'],
      bad: ['gets uncomfortable after about two hours'],
    },
    battery: {
      good: ['charge lasts most of a week on my commute'],
      bad: ['the case runs out faster than advertised'],
    },
    noise_cancellation: {
      good: ['cuts out traffic noise on the commute properly'],
      bad: ['noise cancelling is average — fine for hum, poor for voices'],
    },
    value: {
      good: ['excellent for the money'],
      bad: ['there are cheaper pairs that do most of this'],
    },
  },
  accessory: {
    build: {
      good: ['well made and fits exactly as described', 'feels far sturdier than the price suggests'],
      bad: ['the finish scratches easily'],
    },
    value: {
      good: ['does its job and costs very little', 'no complaints at this price'],
      bad: ['fine, but nothing special for the money'],
    },
    compatibility: {
      good: ['fitted my device first time with no fuss'],
      bad: ['check your model carefully before ordering'],
    },
  },
  display_device: {
    picture: {
      good: ['picture quality is excellent straight out of the box', 'colours look natural without fiddling with settings'],
      bad: ['needs calibrating before it looks its best'],
    },
    features: {
      good: ['the 120Hz makes a real difference for console gaming'],
      bad: ['the built-in software is slow'],
    },
    value: {
      good: ['a lot of screen for the money'],
      bad: ['pricey compared to similar panels'],
    },
  },
};

/** Which opinion set fits a category. */
function familyFor(slug) {
  if (['smartphones'].includes(slug)) return 'phone';
  if (['laptops', 'gaming-laptops'].includes(slug)) return 'laptop';
  if (['headphones', 'earbuds', 'gaming-headsets'].includes(slug)) return 'audio';
  if (['televisions', 'monitors'].includes(slug)) return 'display_device';
  return 'accessory';
}

const TITLES = {
  5: ['Exactly what I wanted', 'No regrets', 'Better than expected', 'Worth every rupee'],
  4: ['Very good, with one niggle', 'Happy with it', 'Solid buy', 'Good, not perfect'],
  3: ['Decent, but read the details', 'Mixed feelings', 'Okay for the price'],
  2: ['Not for me', 'Expected more', 'Disappointing in one big way'],
  1: ['Would not buy again', 'Sending it back'],
};

/**
 * The rating shape for a product.
 *
 * Most products land well but not perfectly; a minority are genuinely
 * mediocre. Derived from the SKU so it is stable, and deliberately spread so
 * that "sort by rating" and "4 stars and above" both separate the catalogue
 * instead of returning all of it or none of it.
 */
function profileFor(random, price) {
  const roll = random();

  // Skewed by price, because that is how reviews actually fall: a flagship
  // that disappoints gets returned rather than rated two stars, while cheap
  // accessories collect the widest range of opinion. A flat distribution put
  // the iPhone 16 on 2.8 stars, which reads as a broken catalogue rather than
  // as a divided one.
  if (price >= 60000) {
    if (roll < 0.06) return { centre: 3.7, spread: 1.1 };
    if (roll < 0.30) return { centre: 4.3, spread: 0.7 };
    return { centre: 4.6, spread: 0.5 };
  }

  if (price >= 15000) {
    if (roll < 0.12) return { centre: 3.4, spread: 1.2 };
    if (roll < 0.40) return { centre: 4.1, spread: 0.8 };
    return { centre: 4.5, spread: 0.6 };
  }

  // Budget: the widest spread, and where the genuinely poor ones live.
  if (roll < 0.18) return { centre: 3.1, spread: 1.3 };
  if (roll < 0.46) return { centre: 4.0, spread: 0.9 };
  return { centre: 4.5, spread: 0.7 };
}

function buildReviews(product) {
  const random = rng(seedOf(product.sku || product.id));
  const family = ASPECTS[familyFor(product.category_slug)];
  const aspectNames = Object.keys(family);
  const profile = profileFor(random, product.price);

  const count = 6 + Math.floor(random() * 15); // 6-20 reviews
  const reviews = [];

  for (let i = 0; i < count; i++) {
    // Ratings cluster around the product's centre.
    const raw = profile.centre + (random() - 0.5) * 2 * profile.spread;
    const rating = Math.max(1, Math.min(5, Math.round(raw)));

    // A review talks about one or two aspects, praising or criticising them in
    // line with the score it gave.
    const chosen = [aspectNames[Math.floor(random() * aspectNames.length)]];
    if (random() < 0.45) {
      const second = aspectNames[Math.floor(random() * aspectNames.length)];
      if (second !== chosen[0]) chosen.push(second);
    }

    const aspects = {};
    const clauses = [];
    for (const aspect of chosen) {
      // High scores mostly praise, low scores mostly criticise, and the middle
      // does both — which is where the useful detail lives.
      const positive = rating >= 4 ? random() < 0.88 : rating === 3 ? random() < 0.45 : random() < 0.12;
      const lines = positive ? family[aspect].good : family[aspect].bad;
      if (!lines || lines.length === 0) continue;
      aspects[aspect] = positive ? 'positive' : 'negative';
      clauses.push(pick(random, lines));
    }
    if (clauses.length === 0) continue;

    const opener =
      rating >= 4
        ? pick(random, ['Really pleased with this.', 'Bought it last month.', 'Upgraded from an older model.'])
        : rating === 3
          ? pick(random, ['Mixed on this one.', 'It is fine, with caveats.'])
          : pick(random, ['Not what I hoped for.', 'Returned mine.']);

    // The clauses are written to follow "and", so the first one needs a capital
    // when it follows a full stop instead.
    const joined = clauses.join(', and ');
    const body = `${opener} ${joined.charAt(0).toUpperCase()}${joined.slice(1)}.`;

    // Spread over the last ~10 months so "recent reviews" means something.
    const daysAgo = Math.floor(random() * 300) + 3;
    const created = new Date(Date.now() - daysAgo * 86400000).toISOString();

    reviews.push({
      product_id: product.id,
      author_name: author(random),
      rating,
      title: pick(random, TITLES[rating]),
      body,
      aspects,
      is_verified_purchase: random() < 0.82,
      created_at: created,
    });
  }

  return reviews;
}

/* --------------------------------------------------------------------- run */

const { data: products, error } = await db
  .from('products')
  .select('id, sku, name, price, is_active, categories(slug)')
  .eq('is_active', true);

if (error) {
  console.error('Could not read products:', error.message);
  process.exit(1);
}

console.log(`Seeding demo reviews for ${products.length} active products…\n`);

let written = 0;
let replaced = 0;

for (const row of products) {
  const product = {
    id: row.id,
    sku: row.sku,
    name: row.name,
    price: Number(row.price ?? 0),
    category_slug: row.categories?.slug ?? '',
  };

  const reviews = buildReviews(product);

  // Replace rather than append, so re-running does not multiply the count.
  const { count: existing } = await db
    .from('product_reviews')
    .select('*', { count: 'exact', head: true })
    .eq('product_id', product.id);

  if (existing && existing > 0) {
    await db.from('product_reviews').delete().eq('product_id', product.id);
    replaced++;
  }

  const { error: insertError } = await db.from('product_reviews').insert(reviews);
  if (insertError) {
    console.error(`  ${product.name}: ${insertError.message}`);
    continue;
  }
  written += reviews.length;
}

const { data: check } = await db
  .from('products')
  .select('rating, review_count')
  .eq('is_active', true);

const rated = (check ?? []).filter((p) => p.review_count > 0);
const average =
  rated.length > 0 ? rated.reduce((sum, p) => sum + Number(p.rating), 0) / rated.length : 0;
const buckets = { '4.5+': 0, '4.0-4.4': 0, '3.5-3.9': 0, 'under 3.5': 0 };
for (const p of rated) {
  const r = Number(p.rating);
  if (r >= 4.5) buckets['4.5+']++;
  else if (r >= 4) buckets['4.0-4.4']++;
  else if (r >= 3.5) buckets['3.5-3.9']++;
  else buckets['under 3.5']++;
}

console.log(`reviews written    : ${written}`);
console.log(`products replaced  : ${replaced}`);
console.log(`products with rating: ${rated.length} of ${products.length}`);
console.log(`mean rating        : ${average.toFixed(2)}`);
console.log('spread             :', JSON.stringify(buckets));
console.log('\nRatings are maintained by trigger, so these came from the rows themselves.');
