-- Point order creation at the short YYMMXXX numbers from 0016.
--
-- This is the only place an order number is minted; finalize_paid_payment
-- delegates here rather than building its own, so one line changes the format
-- everywhere. The body is otherwise identical to 0011.
--
-- Existing SQ-2026-#### orders keep their numbers. They are still unique and
-- still resolve, and rewriting the number on an order a customer already has
-- a confirmation email for would break the only reference they hold.
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
  v_order_number := public.next_order_number();

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

-- create-or-replace preserves the ACL, but 0011 learned the hard way that
-- this is worth asserting rather than assuming.
revoke execute on function public.create_order_from_cart(uuid, uuid, text, text, jsonb, text, text, text, text)
  from public, anon, authenticated;

grant execute on function public.create_order_from_cart(uuid, uuid, text, text, jsonb, text, text, text, text)
  to service_role;
