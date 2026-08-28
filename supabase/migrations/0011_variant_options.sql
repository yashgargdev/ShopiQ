-- Variant options on a line item.
--
-- Storage size is already modelled as separate products, each with its own
-- SKU, price and inventory row. Colour is not: there is one SKU per storage
-- size, and every colour of it draws on the same stock. Until now colour
-- existed only inside an image filename, so a shopper could not choose one and
-- an order could not record which one they chose.
--
-- `selected_options` records that choice and nothing more. It deliberately
-- does NOT imply per-colour stock — the availability figures still come from
-- the one inventory row behind the SKU, which is the truth we actually hold.
-- Claiming otherwise would put a number in front of a customer that no table
-- in this database can support.

alter table public.cart_items
  add column if not exists selected_options jsonb not null default '{}'::jsonb;

comment on column public.cart_items.selected_options is
  'Shopper-chosen options for this line, e.g. {"colour":"Sage"}. Presentation and fulfilment detail only — stock is tracked per product, not per option.';

-- Two colours of the same phone are two lines, not one merged line. The old
-- constraint would have silently folded them together and lost a choice the
-- customer had explicitly made.
alter table public.cart_items
  drop constraint if exists cart_items_cart_id_product_id_key;

create unique index if not exists cart_items_cart_product_options_key
  on public.cart_items (cart_id, product_id, selected_options);

-- Orders keep their own snapshot of everything, so the choice has to be copied
-- onto the line rather than looked up later: the cart is gone by then, and the
-- product row may since have changed or been deleted.
alter table public.order_items
  add column if not exists selected_options jsonb not null default '{}'::jsonb;

comment on column public.order_items.selected_options is
  'Options chosen at purchase time, snapshotted alongside name, price and SKU.';

-- cart_add_item now carries the chosen options, and they participate in line
-- identity: adding a Sage iPhone 17 when a White one is already in the cart is
-- a second line, not a quantity bump. Stock handling is unchanged — it is
-- still per product, because that is the only figure inventory holds.
--
-- Note the explicit drop below. Adding a defaulted parameter creates an
-- OVERLOAD rather than replacing the function; both signatures then match a
-- four-argument call, Postgres refuses to choose between them, and every add
-- to cart fails.
create or replace function public.cart_add_item(
  p_cart_id          uuid,
  p_product_id       uuid,
  p_quantity         integer,
  p_max_per_line     integer default 20,
  p_selected_options jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_active    boolean;
  v_name      text;
  v_price     numeric(12,2);
  v_available integer;
  v_item_id   uuid;
  v_existing  integer;
  v_requested integer;
  v_applied   integer;
  v_options   jsonb := coalesce(p_selected_options, '{}'::jsonb);
begin
  if p_quantity is null or p_quantity < 1 then
    raise exception 'INVALID_QUANTITY';
  end if;

  select p.is_active, p.name, p.price, greatest(i.quantity - i.reserved_quantity, 0)
    into v_active, v_name, v_price, v_available
    from public.products p
    join public.inventory i on i.product_id = p.id
   where p.id = p_product_id
     for update of i;

  if not found then
    raise exception 'PRODUCT_NOT_FOUND';
  end if;
  if not v_active then
    raise exception 'PRODUCT_INACTIVE:%', v_name;
  end if;
  if v_available <= 0 then
    raise exception 'OUT_OF_STOCK:%', v_name;
  end if;

  select id, quantity into v_item_id, v_existing
    from public.cart_items
   where cart_id = p_cart_id
     and product_id = p_product_id
     and selected_options = v_options;

  v_existing  := coalesce(v_existing, 0);
  v_requested := v_existing + p_quantity;
  v_applied   := least(v_requested, v_available, greatest(p_max_per_line, 1));

  if v_item_id is null then
    insert into public.cart_items (cart_id, product_id, quantity, price_at_add, selected_options)
    values (p_cart_id, p_product_id, v_applied, v_price, v_options)
    returning id into v_item_id;
  else
    update public.cart_items set quantity = v_applied where id = v_item_id;
  end if;

  return jsonb_build_object(
    'cartItemId',       v_item_id,
    'productName',      v_name,
    'previousQuantity', v_existing,
    'requestedTotal',   v_requested,
    'appliedTotal',     v_applied,
    'available',        v_available,
    'selectedOptions',  v_options,
    'clamped',          v_requested > v_applied
  );
end;
$$;

drop function if exists public.cart_add_item(uuid, uuid, integer, integer);
create or replace function public.create_order_from_cart(
  p_cart_id           uuid,
  p_customer_id       uuid,
  p_contact_email     text,
  p_contact_phone     text,
  p_shipping_address  jsonb,
  p_notes             text default null,
  p_payment_status    text default 'unpaid',
  p_payment_method    text default 'test_order',
  p_payment_reference text default null
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

  if p_payment_status not in ('unpaid', 'paid', 'failed', 'refunded') then
    raise exception 'INVALID_PAYMENT_STATUS';
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
    order_number, customer_id, status, payment_status, payment_method, payment_reference,
    subtotal, shipping_amount, total, currency,
    shipping_address, contact_email, contact_phone, notes
  ) values (
    v_order_number, p_customer_id, 'confirmed', p_payment_status, p_payment_method, p_payment_reference,
    v_subtotal, v_shipping, v_total, 'INR',
    p_shipping_address, p_contact_email, p_contact_phone, p_notes
  ) returning id into v_order_id;

  -- Snapshot: these values must never be recomputed from today's catalogue.
  insert into public.order_items (
    order_id, product_id, product_name, product_slug, brand, sku,
    image_url, quantity, unit_price, total_price, selected_options
  )
  select v_order_id, p.id, p.name, p.slug, p.brand, p.sku,
         (select pi.public_url from public.product_images pi
           where pi.product_id = p.id order by pi.is_primary desc, pi.sort_order limit 1),
         ci.quantity, p.price, p.price * ci.quantity,
         coalesce(ci.selected_options, '{}'::jsonb)
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


-- Re-lock cart_add_item after its signature changed.
--
-- Dropping the old four-argument function dropped its ACL with it, and the new
-- one was created with Postgres's default: EXECUTE to PUBLIC. That is exactly
-- the hazard 0004 was written to prevent — cart_add_item is SECURITY DEFINER
-- and takes a cart id, so a PUBLIC grant would let anon write items into any
-- cart whose id they could guess.
--
-- As 0004 notes, revoking from PUBLIC alone is not enough: the explicit anon
-- and authenticated grants survive it and must be named.
revoke execute on function public.cart_add_item(uuid, uuid, integer, integer, jsonb)
  from public, anon, authenticated;

grant execute on function public.cart_add_item(uuid, uuid, integer, integer, jsonb)
  to service_role;
