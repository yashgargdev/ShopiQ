-- ============================================================================
-- ShopiQ — catalogue, inventory and ordering functions
-- ============================================================================
-- Grants are applied in 0004_function_privileges.sql. Read that file before
-- assuming anything here is safe to expose: on Supabase, functions in the
-- public schema are reachable over PostgREST by default.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Availability, without leaking reserved_quantity
-- ---------------------------------------------------------------------------

create or replace function public.get_products_stock(p_product_ids uuid[])
returns table (
  product_id uuid,
  available  integer,
  in_stock   boolean,
  low_stock  boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select i.product_id,
         greatest(i.available, 0)                                as available,
         i.available > 0                                         as in_stock,
         i.available > 0 and i.available <= i.low_stock_threshold as low_stock
    from public.inventory i
    join public.products p on p.id = i.product_id
   where i.product_id = any(p_product_ids)
     and p.is_active;
$$;

-- ---------------------------------------------------------------------------
-- Catalogue listing + full-text search
-- ---------------------------------------------------------------------------
-- One function backs both GET /api/products and GET /api/products/search — the
-- only difference is whether p_query is supplied. Returns each product as a
-- jsonb document plus the total match count, so a listing page is a single
-- round trip.
--
-- Matching is on the OR-form of the query (recall); ranking then rewards, in
-- order: every word present, the query naming the product's category, and a
-- literal name/brand hit. The category term is what keeps a search for
-- "laptop" from putting a "Laptop Backpack" above actual laptops.
-- ---------------------------------------------------------------------------

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
  p_offset        integer default 0
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
  -- A category filter includes that category's children.
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
       and ((select ts_or from args) is null
            or p.search_vector @@ (select ts_or from args)
            -- Substring fallback so a partial brand or model still lands.
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

-- ---------------------------------------------------------------------------
-- Facets for the filter sidebar (brand counts, category counts, price bounds)
-- ---------------------------------------------------------------------------

create or replace function public.get_catalog_facets(p_category_slug text default null)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with cat as (
    select c.id from public.categories c
     where p_category_slug is not null
       and (c.slug = p_category_slug
            or c.parent_id in (select c2.id from public.categories c2 where c2.slug = p_category_slug))
  ),
  scoped as (
    select p.* from public.products p
     where p.is_active and (p_category_slug is null or p.category_id in (select id from cat))
  )
  select jsonb_build_object(
    'brands', coalesce((select jsonb_agg(x order by x->>'name')
        from (select jsonb_build_object('name', brand, 'count', count(*)) as x
                from scoped group by brand) b), '[]'::jsonb),
    'categories', coalesce((select jsonb_agg(
          jsonb_build_object('id', c.id, 'name', c.name, 'slug', c.slug, 'count', t.n) order by t.n desc)
        from (select category_id, count(*) as n from scoped group by category_id) t
        join public.categories c on c.id = t.category_id), '[]'::jsonb),
    'priceRange', jsonb_build_object(
      'min', coalesce((select min(price) from scoped), 0),
      'max', coalesce((select max(price) from scoped), 0)),
    'total', (select count(*) from scoped));
$$;

-- ---------------------------------------------------------------------------
-- Order creation — the only writer of public.orders
-- ---------------------------------------------------------------------------
-- One transaction: lock the inventory rows, re-read every price from
-- public.products (client-supplied prices are never trusted), verify stock,
-- snapshot the line items, reserve the stock, convert the cart.
-- ---------------------------------------------------------------------------

create or replace function public.create_order_from_cart(
  p_cart_id          uuid,
  p_customer_id      uuid,
  p_contact_email    text,
  p_contact_phone    text,
  p_shipping_address jsonb,
  p_notes            text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order_id     uuid;
  v_order_number text;
  v_subtotal     numeric(12,2) := 0;
  v_shipping     numeric(12,2) := 0;
  v_total        numeric(12,2);
  v_line_count   integer := 0;
  v_item         record;
begin
  if p_customer_id is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  -- Deterministic lock order avoids deadlocks between concurrent checkouts.
  perform 1 from public.inventory i
    where i.product_id in (select ci.product_id from public.cart_items ci where ci.cart_id = p_cart_id)
    order by i.product_id for update;

  for v_item in
    select ci.quantity, p.name, p.price, p.is_active, i.available
      from public.cart_items ci
      join public.products  p on p.id = ci.product_id
      join public.inventory i on i.product_id = ci.product_id
     where ci.cart_id = p_cart_id
  loop
    if not v_item.is_active then
      raise exception 'PRODUCT_UNAVAILABLE:%', v_item.name;
    end if;
    if v_item.available < v_item.quantity then
      raise exception 'INSUFFICIENT_STOCK:%:%', v_item.name, v_item.available;
    end if;
    v_subtotal   := v_subtotal + (v_item.price * v_item.quantity);
    v_line_count := v_line_count + 1;
  end loop;

  if v_line_count = 0 then
    raise exception 'CART_EMPTY';
  end if;

  -- Free delivery over ₹999, otherwise a flat ₹79. Mirrored in lib/cart.
  v_shipping     := case when v_subtotal >= 999 then 0 else 79 end;
  v_total        := v_subtotal + v_shipping;
  v_order_number := 'SQ-' || to_char(now(), 'YYYY') || '-' || nextval('public.order_number_seq');

  insert into public.orders (
    order_number, customer_id, status, payment_status, payment_method,
    subtotal, shipping_amount, total, currency,
    shipping_address, contact_email, contact_phone, notes
  ) values (
    v_order_number, p_customer_id, 'confirmed', 'unpaid', 'test_order',
    v_subtotal, v_shipping, v_total, 'INR',
    p_shipping_address, p_contact_email, p_contact_phone, p_notes
  ) returning id into v_order_id;

  -- Snapshot: these values must never be recomputed from today's catalogue.
  insert into public.order_items (
    order_id, product_id, product_name, product_slug, brand, sku,
    image_url, quantity, unit_price, total_price
  )
  select v_order_id, p.id, p.name, p.slug, p.brand, p.sku,
         (select pi.public_url from public.product_images pi
           where pi.product_id = p.id order by pi.is_primary desc, pi.sort_order limit 1),
         ci.quantity, p.price, p.price * ci.quantity
    from public.cart_items ci
    join public.products p on p.id = ci.product_id
   where ci.cart_id = p_cart_id;

  -- Hold the stock. It leaves `quantity` when the order ships.
  update public.inventory i
     set reserved_quantity = i.reserved_quantity + ci.quantity
    from public.cart_items ci
   where ci.cart_id = p_cart_id and i.product_id = ci.product_id;

  delete from public.cart_items where cart_id = p_cart_id;
  update public.carts set status = 'converted' where id = p_cart_id;

  return jsonb_build_object(
    'orderId', v_order_id, 'orderNumber', v_order_number,
    'subtotal', v_subtotal, 'shippingAmount', v_shipping, 'total', v_total);
end;
$$;

-- ---------------------------------------------------------------------------
-- Order status transitions, with the matching inventory movement
-- ---------------------------------------------------------------------------
--   reserved  (pending / confirmed / processing) → held in reserved_quantity
--   consumed  (shipped / delivered)              → has left quantity
--   released  (cancelled / refunded)             → back on the shelf
-- ---------------------------------------------------------------------------

create or replace function public.order_stock_class(p_status text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select case
    when p_status in ('pending', 'confirmed', 'processing') then 'reserved'
    when p_status in ('shipped', 'delivered')               then 'consumed'
    else 'released'
  end;
$$;

create or replace function public.set_order_status(p_order_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old  text;
  v_from text;
  v_to   text;
begin
  select status into v_old from public.orders where id = p_order_id for update;
  if v_old is null then
    raise exception 'ORDER_NOT_FOUND';
  end if;
  if v_old = p_status then
    return jsonb_build_object('orderId', p_order_id, 'status', p_status, 'changed', false);
  end if;

  v_from := public.order_stock_class(v_old);
  v_to   := public.order_stock_class(p_status);

  perform 1 from public.inventory i
    where i.product_id in (select oi.product_id from public.order_items oi where oi.order_id = p_order_id)
    order by i.product_id for update;

  if v_from = 'reserved' and v_to = 'consumed' then
    update public.inventory i
       set quantity = i.quantity - oi.quantity,
           reserved_quantity = i.reserved_quantity - oi.quantity
      from public.order_items oi
     where oi.order_id = p_order_id and i.product_id = oi.product_id;

  elsif v_from = 'reserved' and v_to = 'released' then
    update public.inventory i
       set reserved_quantity = greatest(i.reserved_quantity - oi.quantity, 0)
      from public.order_items oi
     where oi.order_id = p_order_id and i.product_id = oi.product_id;

  elsif v_from = 'consumed' and v_to = 'released' then
    update public.inventory i set quantity = i.quantity + oi.quantity
      from public.order_items oi
     where oi.order_id = p_order_id and i.product_id = oi.product_id;

  elsif v_from = 'consumed' and v_to = 'reserved' then
    update public.inventory i
       set quantity = i.quantity + oi.quantity,
           reserved_quantity = i.reserved_quantity + oi.quantity
      from public.order_items oi
     where oi.order_id = p_order_id and i.product_id = oi.product_id;

  elsif v_from = 'released' and v_to = 'reserved' then
    update public.inventory i set reserved_quantity = i.reserved_quantity + oi.quantity
      from public.order_items oi
     where oi.order_id = p_order_id and i.product_id = oi.product_id;

  elsif v_from = 'released' and v_to = 'consumed' then
    update public.inventory i set quantity = greatest(i.quantity - oi.quantity, 0)
      from public.order_items oi
     where oi.order_id = p_order_id and i.product_id = oi.product_id;
  end if;

  update public.orders
     set status = p_status,
         payment_status = case
           when p_status in ('cancelled', 'refunded') and payment_status = 'paid' then 'refunded'
           else payment_status
         end
   where id = p_order_id;

  return jsonb_build_object('orderId', p_order_id, 'status', p_status, 'changed', true);
exception
  when check_violation then
    raise exception 'INVENTORY_CONFLICT';
end;
$$;

-- ---------------------------------------------------------------------------
-- Merchant dashboard statistics (real numbers only — no placeholders)
-- ---------------------------------------------------------------------------

create or replace function public.merchant_dashboard_stats()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'totalOrders',      (select count(*) from public.orders),
    'paidOrders',       (select count(*) from public.orders where payment_status = 'paid'),
    'openOrders',       (select count(*) from public.orders
                          where status in ('pending', 'confirmed', 'processing')),
    'cancelledOrders',  (select count(*) from public.orders where status in ('cancelled', 'refunded')),
    -- Revenue excludes cancelled and refunded orders.
    'totalRevenue',     (select coalesce(sum(total), 0) from public.orders
                          where status not in ('cancelled', 'refunded')),
    'averageOrderValue',(select coalesce(round(avg(total), 2), 0) from public.orders
                          where status not in ('cancelled', 'refunded')),
    'totalProducts',    (select count(*) from public.products),
    'activeProducts',   (select count(*) from public.products where is_active),
    'totalCategories',  (select count(*) from public.categories where is_active),
    'unitsOnHand',      (select coalesce(sum(quantity), 0) from public.inventory),
    'lowStockProducts', (select count(*) from public.inventory i join public.products p on p.id = i.product_id
                          where p.is_active and i.available > 0 and i.available <= i.low_stock_threshold),
    'outOfStockProducts',(select count(*) from public.inventory i join public.products p on p.id = i.product_id
                          where p.is_active and i.available <= 0),
    'recentRevenue',    coalesce((
        select jsonb_agg(jsonb_build_object('day', d.day, 'revenue', d.revenue, 'orders', d.orders)
                         order by d.day)
          from (select date_trunc('day', o.created_at)::date as day,
                       sum(o.total) as revenue, count(*) as orders
                  from public.orders o
                 where o.created_at >= now() - interval '30 days'
                   and o.status not in ('cancelled', 'refunded')
                 group by 1) d), '[]'::jsonb),
    'topProducts',      coalesce((
        select jsonb_agg(jsonb_build_object('name', t.product_name, 'units', t.units, 'revenue', t.revenue)
                         order by t.revenue desc)
          from (select oi.product_name, sum(oi.quantity) as units, sum(oi.total_price) as revenue
                  from public.order_items oi join public.orders o on o.id = oi.order_id
                 where o.status not in ('cancelled', 'refunded')
                 group by oi.product_name
                 order by revenue desc limit 5) t), '[]'::jsonb));
$$;
