-- Customer reviews, and the aggregates the catalogue already claimed to have.
--
-- products.rating and products.review_count existed from the first migration
-- but nothing ever wrote them, so every product read 0.0 from 0 reviews: the
-- rating filter could never match, "sort by rating" ordered nothing, and the
-- assistant told every shopper it had no ratings for anything.
--
-- The aggregates stay on products because that is what search and sort read,
-- and they are maintained by trigger rather than by whoever happens to insert
-- a review. A denormalised column with two writers eventually disagrees with
-- itself; with one, it cannot.

create table if not exists public.product_reviews (
  id                   uuid primary key default gen_random_uuid(),
  product_id           uuid not null references public.products(id) on delete cascade,
  author_name          text not null,
  rating               smallint not null check (rating between 1 and 5),
  title                text,
  body                 text not null,
  -- Which aspects this review speaks to, and whether well or badly:
  -- {"battery": "positive", "weight": "negative"}. Written at seed time so a
  -- summary can be computed rather than inferred from prose by a model.
  aspects              jsonb not null default '{}'::jsonb,
  is_verified_purchase boolean not null default true,
  created_at           timestamptz not null default now()
);

create index if not exists product_reviews_product_idx
  on public.product_reviews (product_id, created_at desc);

comment on table public.product_reviews is
  'DEMO DATA. Written by scripts/seed-reviews.mjs for demonstration; these are not real customer reviews and are labelled as such wherever they are shown.';

/**
 * Keep products.rating and products.review_count true to the reviews.
 *
 * Recomputed from the rows rather than incremented, so it is correct after a
 * delete, a re-seed, or an edited rating — an incrementing counter drifts the
 * first time anything unusual happens to a row.
 */
create or replace function public.refresh_product_rating()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_product uuid := coalesce(new.product_id, old.product_id);
begin
  update public.products p
     set rating = coalesce((
           select round(avg(r.rating)::numeric, 1)
             from public.product_reviews r
            where r.product_id = v_product
         ), 0),
         review_count = (
           select count(*) from public.product_reviews r where r.product_id = v_product
         )
   where p.id = v_product;

  return null;
end;
$$;

drop trigger if exists product_reviews_refresh_rating on public.product_reviews;

create trigger product_reviews_refresh_rating
  after insert or update or delete on public.product_reviews
  for each row execute function public.refresh_product_rating();

-- Reviews are catalogue content: readable by anyone who can read the product.
alter table public.product_reviews enable row level security;

drop policy if exists "product reviews are publicly readable" on public.product_reviews;

create policy "product reviews are publicly readable"
  on public.product_reviews
  for select
  using (
    exists (
      select 1 from public.products p
       where p.id = product_reviews.product_id and p.is_active
    )
  );

-- No insert/update/delete policy: writing goes through the service role, which
-- bypasses RLS. A shopper cannot post a review, which is honest — nothing in
-- ShopiQ verifies that they bought the thing.
revoke all on function public.refresh_product_rating() from public, anon, authenticated;
