-- ============================================================================
-- ShopiQ Phase 2 — specification filtering in search_products
-- ============================================================================
-- Adds `p_spec_filters` so the AI tool layer can express "at least 16 GB of
-- RAM" or "an RTX 4060" as a real query against the typed products.specs
-- JSONB, rather than fetching everything and filtering in application code.
--
-- Contract: a JSONB array of {key, op, value}, where op is gte | lte | eq |
-- contains. Two properties matter for correctness:
--
--   1. A product that does not record the key NEVER matches. Silently letting
--      it through would mean "16 GB minimum" returned t-shirts.
--   2. A non-numeric value on a range comparison yields no rows rather than a
--      SQL error, so a hallucinated `{"ram_gb": "banana"}` degrades safely.
--
-- The old 11-argument signature is dropped rather than left alongside: two
-- overloads that both have defaults make a named-argument call ambiguous.
-- ============================================================================

drop function if exists public.search_products(
  text, text, text[], numeric, numeric, numeric, boolean, boolean, text, integer, integer);

create or replace function public.search_products(
  p_query         text    default null,
  p_category_slug text    default null,
  p_brands        text[]  default null,
  p_min_price     numeric default null,
  p_max_price     numeric default null,
  p_min_rating    numeric default null,
  p_in_stock_only boolean default false,
  p_featured_only boolean default false,
  p_sort          text    default 'relevance',
  p_limit         integer default 20,
  p_offset        integer default 0,
  p_spec_filters  jsonb   default null
)
returns table (product jsonb, total_count bigint)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with args as (
    select nullif(btrim(coalesce(p_query, '')), '') as raw,
           case when nullif(btrim(coalesce(p_query, '')), '') is null then null
                else websearch_to_tsquery('english', p_query) end as ts_and,
           case when nullif(btrim(coalesce(p_query, '')), '') is null then null
                else nullif(replace(plainto_tsquery('english', p_query)::text, '&', '|'), '')::tsquery
           end as ts_or,
           least(greatest(coalesce(p_limit, 20), 1), 60) as lim,
           greatest(coalesce(p_offset, 0), 0) as off
  ),
  cat as (
    select c.id from public.categories c
     where p_category_slug is not null
       and (c.slug = p_category_slug
            or c.parent_id in (select c2.id from public.categories c2 where c2.slug = p_category_slug))
  ),
  base as (
    select p.id, p.rating, p.price, p.created_at, p.compare_at_price,
           case when (select ts_or from args) is null then 0::real
                else ts_rank(p.search_vector, (select ts_or from args))
                     + 3 * coalesce(ts_rank(p.search_vector, (select ts_and from args)), 0)
                     + case when to_tsvector('english', pc.name || ' ' || coalesce(pp.name, ''))
                                 @@ (select ts_and from args) then 2.5
                            when to_tsvector('english', pc.name || ' ' || coalesce(pp.name, ''))
                                 @@ (select ts_or from args) then 1.2
                            else 0 end
                     + case when p.name ilike '%' || (select raw from args) || '%'
                            or p.brand ilike '%' || (select raw from args) || '%'
                            then 0.6 else 0 end
           end as rank
      from public.products p
      join public.inventory i on i.product_id = p.id
      join public.categories pc on pc.id = p.category_id
      left join public.categories pp on pp.id = pc.parent_id
     where p.is_active
       and (p_category_slug is null or p.category_id in (select id from cat))
       and (p_brands is null or cardinality(p_brands) = 0 or p.brand = any (p_brands))
       and (p_min_price is null or p.price >= p_min_price)
       and (p_max_price is null or p.price <= p_max_price)
       and (p_min_rating is null or p.rating >= p_min_rating)
       and (not coalesce(p_in_stock_only, false) or i.available > 0)
       and (not coalesce(p_featured_only, false) or p.is_featured)
       -- Specification filters. CASE guarantees ordered evaluation, so the
       -- regex guard always runs before the numeric cast.
       and (p_spec_filters is null
            or jsonb_typeof(p_spec_filters) <> 'array'
            or jsonb_array_length(p_spec_filters) = 0
            or (select coalesce(bool_and(
                  case f->>'op'
                    when 'gte' then
                      case when (p.specs->>(f->>'key')) ~ '^-?[0-9]+(\.[0-9]+)?$'
                            and (f->>'value') ~ '^-?[0-9]+(\.[0-9]+)?$'
                           then (p.specs->>(f->>'key'))::numeric >= (f->>'value')::numeric
                           else false end
                    when 'lte' then
                      case when (p.specs->>(f->>'key')) ~ '^-?[0-9]+(\.[0-9]+)?$'
                            and (f->>'value') ~ '^-?[0-9]+(\.[0-9]+)?$'
                           then (p.specs->>(f->>'key'))::numeric <= (f->>'value')::numeric
                           else false end
                    when 'eq' then
                      lower(coalesce(p.specs->>(f->>'key'), '')) = lower(coalesce(f->>'value', ''))
                    when 'contains' then
                      coalesce(p.specs->>(f->>'key'), '') ilike '%' || coalesce(f->>'value', '') || '%'
                    else true
                  end), true)
                from jsonb_array_elements(p_spec_filters) f))
       and ((select ts_or from args) is null
            or p.search_vector @@ (select ts_or from args)
            or p.name ilike '%' || (select raw from args) || '%'
            or p.brand ilike '%' || (select raw from args) || '%')
  ),
  counted as (select b.*, count(*) over () as total_count from base b),
  paged as (
    select c.* from counted c
     order by
       case when p_sort = 'relevance' then c.rank end desc nulls last,
       case when p_sort = 'price_asc' then c.price end asc nulls last,
       case when p_sort = 'price_desc' then c.price end desc nulls last,
       case when p_sort = 'rating' then c.rating end desc nulls last,
       case when p_sort = 'newest' then c.created_at end desc nulls last,
       case when p_sort = 'discount' then coalesce(c.compare_at_price, c.price) - c.price end desc nulls last,
       c.rating desc, c.id
     limit (select lim from args) offset (select off from args)
  )
  select jsonb_build_object(
      'id', p.id, 'name', p.name, 'slug', p.slug, 'brand', p.brand, 'sku', p.sku,
      'shortDescription', p.short_description,
      'price', p.price, 'compareAtPrice', p.compare_at_price, 'currency', p.currency,
      'rating', p.rating, 'reviewCount', p.review_count, 'isFeatured', p.is_featured,
      'tags', to_jsonb(p.tags), 'specs', p.specs,
      'category', jsonb_build_object('id', c.id, 'name', c.name, 'slug', c.slug),
      'image', img.public_url, 'imageAlt', img.alt_text,
      'availability', jsonb_build_object(
        'available', greatest(i.available, 0),
        'inStock', i.available > 0,
        'lowStock', i.available > 0 and i.available <= i.low_stock_threshold)
    ) as product,
    paged.total_count
  from paged
  join public.products p on p.id = paged.id
  join public.categories c on c.id = p.category_id
  join public.inventory i on i.product_id = p.id
  left join lateral (
    select pi.public_url, pi.alt_text from public.product_images pi
     where pi.product_id = p.id order by pi.is_primary desc, pi.sort_order limit 1
  ) img on true
  order by
    case when p_sort = 'relevance' then paged.rank end desc nulls last,
    case when p_sort = 'price_asc' then paged.price end asc nulls last,
    case when p_sort = 'price_desc' then paged.price end desc nulls last,
    case when p_sort = 'rating' then paged.rating end desc nulls last,
    case when p_sort = 'newest' then paged.created_at end desc nulls last,
    case when p_sort = 'discount' then coalesce(paged.compare_at_price, paged.price) - paged.price end desc nulls last,
    paged.rating desc, paged.id;
$$;

-- Same exposure as before: the catalogue read path is intentionally public.
revoke execute on function public.search_products(
  text, text, text[], numeric, numeric, numeric, boolean, boolean, text, integer, integer, jsonb)
  from public;
grant execute on function public.search_products(
  text, text, text[], numeric, numeric, numeric, boolean, boolean, text, integer, integer, jsonb)
  to anon, authenticated, service_role;
