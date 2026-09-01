# ShopiQ catalogue layer

The knowledge a large product catalogue needs in order to be *searchable*,
*comparable* and *recommendable* — separate from the products themselves.

Nothing in this directory is a product. The dataset arrives separately and is
imported against [`schema.json`](schema.json); these files describe the shape it
must take and the rules that operate on it, so a catalogue of five products and
one of five hundred are handled by the same code.

```
data/catalog/
├── schema.json          the canonical product shape an import must supply
├── taxonomy.json        the category tree, and what people call each category
├── vocabulary.json      closed lists: segments, use cases, specs, relationships
├── recommendations.json what goes with what, as rules
├── ranking.json         how candidates are scored, as configurable weights
├── catalog.json         the 119-product demo dataset. Generated, not hand-written.
└── fixtures/
    └── test-catalog.json  13 invented products. NOT the catalogue.
```

---

## The separation that matters

Three things are kept apart, because they change for different reasons and at
different rates:

| | What it answers | Where it lives |
|---|---|---|
| **Product data** | What the product *is* | `products`, `product_specs`, `product_images` |
| **Recommendation logic** | *Why* it should be suggested | this directory |
| **Commerce state** | Whether it can be *bought right now* | `inventory`, `carts`, `orders` |

A price change is commerce state. "Gaming laptops go with gaming mice" is
recommendation logic. Mixing them is how a rule ends up hardcoding a price, and
how a catalogue update silently changes what the assistant recommends.

---

## No variant table

A **configuration is a product.** `iPhone 17 256 GB` and `iPhone 17 512 GB` are
two rows in `products`, each with its own SKU, price and inventory. There is no
`product_variants` table and this phase does not add one.

`product_family` is the only thing tying them together, and it is a *string*,
not a foreign key. It exists so the assistant can answer "show me the 1 TB
version" by finding siblings — nothing more. Colour is not a product at all: it
comes from image metadata, and the customer's choice is recorded on the cart
line in `selected_options`.

The tradeoff, stated plainly: **storage has real per-configuration stock,
colour does not.** Every colour of one storage size draws on the same inventory
row. That is a deliberate limit of the data, not an oversight — inventing a
per-colour count would put a number in front of a customer that no table can
support.

---

## Product family and configuration

```jsonc
{
  "id": "asus-tuf-a15-32gb-1tb",
  "product_family": "asus-tuf-a15",        // groups the configurations
  "configuration": { "ram_gb": 32, "storage_gb": 1024 }  // what makes this one different
}
```

`configuration` keys should also appear in `specifications`, so the axis a
shopper chooses along is also an axis they can filter on.

---

## Segments and use cases

**Segments** say what kind of buyer a product is *for* — `gaming`, `flagship`,
`ultraportable`. They are per-category, because "flagship" means nothing for a
cooling pad.

**Use cases** say what it will be *used for*, from one closed list shared by
products and by requirement extraction. Both sides must use the same strings:
a product tagged `gaming_laptop` when the vocabulary says `gaming` is simply
invisible to the matcher, and nothing reports it. `validateCatalogConfig()`
exists to catch exactly that class of silent failure.

---

## Performance: a signal, not a benchmark

```jsonc
"performance": { "gaming": 9, "programming": 9, "portability": 6, "battery": 7 }
```

1–10, **editorial, and comparable only within a category.** A 9 for gaming on a
laptop and a 9 for gaming on a television both mean "good for gaming in its
class". They are not a claim that the two perform alike, and nothing derived
from them may be presented to a customer as a measurement.

---

## Specifications

Normalized keys, split into `numeric` and `text`. Numeric values must be
**numbers** — `"16 GB"` cannot be compared against `16` and would silently drop
the product from every range filter.

One unit per key, stated in `vocabulary.json`. An importer that converts 1 TB to
`1024` in one place and `1000` in another makes "1 TB SSD under 10k" return
different things on different days.

`specification_groups` is presentation only. A key in no group still filters; it
just does not get a heading.

---

## Compatibility

Compatibility is not a preference — a SO-DIMM stick will not go into a desktop,
and no amount of good ranking on price makes it a sensible suggestion. So it
produces **exclusions**, not scores.

```jsonc
"compatibility": {
  "platform": "desktop",
  "attributes": { "memory_type": "DDR5", "form_factor": "DIMM" },
  "compatible_sizes": ["13", "14"],
  "compatible_accessory_types": ["laptop_sleeve", "usb_c_hub"],
  "claims": [{ "predicate": "not_compatible_with", "category": "…", "reason": "…" }]
}
```

Predicates: `compatible_with`, `requires`, `works_with`, `not_compatible_with`,
`recommended_for`.

Two rules govern the assessment:

1. **`not_compatible_with` always wins.** Refusing a sale is worth more than
   making one that ends in a return.
2. **Unknown is not compatible.** Only keys *both* products declare are
   compared. Saying "this might fit" is something a customer can act on;
   silently listing a part that does not fit is not.

---

## Recommendation rules

Rules are data. They name **categories**, never products, so the engine goes and
finds whatever real, in-stock products exist — a rule naming products would need
rewriting every time the catalogue changed.

```jsonc
{
  "id": "gaming-laptop-accessories",
  "when": { "category": { "in": ["laptops", "gaming-laptops"] },
            "segments": { "contains": "gaming" } },
  "recommend": [
    { "category": "gaming-accessories", "type": "accessory", "priority": 10,
      "reason": "a gaming mouse is a real upgrade over a trackpad" }
  ]
}
```

**Conditions** can address `category`, `subcategory`, `brand`, `segments`,
`use_cases`, `tags`, `price`, and any dotted path into `specifications.*`,
`performance.*` or `compatibility.*`.

**Operators**: `equals`, `not_equals`, `greater_than`,
`greater_than_or_equal`, `less_than`, `less_than_or_equal`, `contains`, `in`,
`not_in`, `exists`.

Notes worth knowing:

- A bare value is shorthand for `equals` — rules are edited by hand.
- Several operators on one field are ANDed: `{ "greater_than": 4, "less_than": 9 }`.
- `contains` means membership on a list and substring on a string.
- `exists: false` asserts *absence*.
- A range comparison against a non-numeric value is **false**, not true. It is
  unanswerable, and answering it either way would admit or drop products on a
  comparison that never happened.
- `category` matches through the taxonomy, so a rule on `laptops` also matches
  `gaming-laptops`.

A target may carry `require`, which the **candidate** must satisfy. This is what
makes the PS5 television honest: the rule demands 4K, 120 Hz and HDMI 2.1, so a
60 Hz screen is never offered as one the console can drive. If nothing in stock
qualifies, nothing is offered.

**Relationship types**: `cross_sell`, `upsell`, `alternative`, `accessory`,
`compatible`, `frequently_bought_together`, `ecosystem`, `replacement`,
`upgrade`.

---

## Ranking

Weights live in `ranking.json`, in named profiles — `shopping` for requirement-driven
search, `discovery` for "show me some good laptops", `accessory` for pairings.
Changing how ShopiQ ranks is a change to that file, not a hunt through the code.

Two guardrails are enforced on load:

- **No signal may exceed 40% of a profile's total.** A 60% budget weight makes
  "cheapest" the answer to every question.
- **Hard filters are never scored.** Out of stock, incompatible, and
  explicitly-excluded candidates are *removed*, not ranked low. A product that
  cannot be bought must not appear at position four.

Every returned item carries machine-readable `reasons`. A score with no reasons
cannot be argued with, corrected or audited — `0.91` tells a customer nothing.
Reasons are appended by the signals as they compute, so the explanation is a
by-product of the arithmetic rather than a story told afterwards.

---

## The two-stage flow

```
user request
   ↓  intent extraction            (deterministic rules + model, cross-checked)
   ↓  structured filters
   ↓  database query               category, price, specs — pushed into Postgres
   ↓  candidate products           5–10, never the catalogue
   ↓  compatibility filtering      exclusions applied
   ↓  recommendation rules
   ↓  deterministic ranking        score + reasons, computed in code
   ↓  AI explanation               prose only, over facts already established
```

The model never sees the catalogue. It receives a handful of candidates that
already passed every filter, each carrying the reasons it passed. That is what
makes "the AI may only recommend products in the candidate set" something the
architecture enforces rather than something a prompt politely requests.

---

## Adding to the catalogue

1. Add categories to `taxonomy.json` (and aliases, so people can ask for them).
2. Add segments for those categories in `vocabulary.json`.
3. Add any new spec keys, with their unit.
4. Add rules to `recommendations.json`.
5. Run `npm run test:catalog`.
6. Run `npm run catalog:import` to write the dataset to Supabase.

Step 5 is the important one. The validator checks that the four files agree —
that no rule names a category that does not exist, no spec group names an
undeclared key, no recommendation lacks a reason, and no ranking profile breaks
the guardrails. Every one of those would otherwise fail *silently*, by making
products quietly unreachable rather than by producing an error.

---

## The demo catalogue

`catalog.json` is **119 demo electronics products** across 16 categories,
generated by [`scripts/build-demo-catalog.mjs`](../../scripts/build-demo-catalog.mjs)
and imported by [`scripts/import-catalog.mjs`](../../scripts/import-catalog.mjs).

```bash
node scripts/build-demo-catalog.mjs   # regenerate the file
npm run catalog:import                # write it to Supabase
```

It is generated rather than hand-written because the interesting property is not
any single product but the *shape of the set*: 84 families, several of them in
multiple configurations, enough price spread that a budget question has both a
yes and a no, and deliberate gaps so the assistant has something honest to
refuse. Editing the generator keeps those properties; editing the JSON does not.

### The import never destroys

Products are matched **by SKU**. A second run of an unchanged file creates
nothing, updates the 119 rows in place, and deletes nothing:

```
products created   : 0
products updated   : 119
products retired   : 0
```

A product that disappears from the file is marked `is_active = false`, never
deleted — orders reference products, and a deleted product turns a customer's
order history into broken rows. Orders, carts, customers and payments are not
touched by the importer at all.

### Configurations, not variants

An iPhone 16 at 128 GB and at 256 GB are two products sharing a
`product_family`, exactly as [No variant table](#no-variant-table) describes.
Colour is **not** a column, a table, or a stock unit — it is derived from the
image set, so "the sage one" resolves without a schema that would have to track
inventory per colour.

### Images

Every image is a supplied asset on `cdn.shopiq.yashgarg.co.in`, reused freely
across products. No image URL in this directory was invented, and none was
scraped: an invented URL is a broken image in a demo, which is worse than an
approximate one.

### The gaps are deliberate

The catalogue contains 60 Hz televisions that must never be offered for a PS5, a
Samsung-branded case that must never be offered for an iPhone, and no gaming
laptop under ₹20,000. Each exists so a test can assert the assistant says *no*.
`scripts/test-catalog-data.mjs` runs those assertions against the real database:

```bash
node -r dotenv/config scripts/test-catalog-data.mjs dotenv_config_path=.env.local
```

---

## The fixture

`fixtures/test-catalog.json` is **thirteen invented products** that exist only to
exercise the engine: enough categories to fire every rule, two products in one
family, two brands in one category for diversity, and three deliberate traps —
a sleeve too small for the laptop, SO-DIMM memory that must never be offered for
a desktop, and a 60 Hz television that must never be offered for a console.

It is not the ShopiQ catalogue, carries no image URLs, and is marked
`demo_dataset: true`.
