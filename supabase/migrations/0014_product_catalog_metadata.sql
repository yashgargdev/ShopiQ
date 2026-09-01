-- Structured catalogue knowledge that has nowhere else to live.
--
-- `specs` is the filterable spec bag and `tags` is free-form classification.
-- Neither can hold a compatibility claim, an editorial performance score, or a
-- declared use case — and without somewhere to put them the recommendation
-- engine reads empty objects and quietly recommends a Samsung case for an
-- iPhone. It cannot detect the difference between "no claim" and "no storage".
--
-- ONE column, deliberately. This is not a variant table and does not become
-- one: it holds facts ABOUT a product, never a purchasable configuration.
-- Every configuration remains its own row in products, as it already was.
--
-- Not indexed on purpose. It is read alongside a product that has already been
-- selected by category, price and specs — all of which are indexed — so it is
-- never the thing a query filters on.
alter table public.products
  add column if not exists catalog_metadata jsonb not null default '{}'::jsonb;

comment on column public.products.catalog_metadata is
  'Catalogue knowledge for the recommendation engine: segments, use_cases, performance (1-10 editorial signals, NOT benchmarks), compatibility claims, product_family and relationships. Written by scripts/import-catalog.mjs. Never a source of price, stock or identity.';
