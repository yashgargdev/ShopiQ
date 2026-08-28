-- 0009 — Phase 4: agentic checkout and Razorpay test-mode payments.
--
-- Four tables and one extended RPC. The guiding rule is the same as every
-- earlier phase: the AI may REQUEST a money action, but only the backend can
-- AUTHORIZE one. Nothing here is reachable by anon or authenticated roles —
-- every write path goes through a route handler that has already checked
-- identity, price, stock and an unexpired confirmation.

-- ---------------------------------------------------------------------------
-- purchase_confirmations
--
-- A confirmation binds a customer's "yes" to an EXACT cart: the items, the
-- quantities, the unit prices and the total, captured at the moment they
-- agreed. cart_hash is a deterministic digest of that snapshot. If the cart
-- moves by so much as one rupee, the hash stops matching and the confirmation
-- can no longer authorize a payment.
-- ---------------------------------------------------------------------------
create table if not exists public.purchase_confirmations (
  id              uuid primary key default gen_random_uuid(),
  customer_id     uuid not null references public.customers(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  cart_id         uuid references public.carts(id) on delete set null,
  cart_snapshot   jsonb not null,
  cart_hash       text not null,
  amount_minor    bigint not null check (amount_minor > 0),
  currency        char(3) not null default 'INR',
  status          text not null default 'pending'
                    check (status in ('pending', 'confirmed', 'expired',
                                      'invalidated', 'consumed', 'cancelled')),
  confirmed_at    timestamptz,
  consumed_at     timestamptz,
  expires_at      timestamptz not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists purchase_confirmations_customer_idx
  on public.purchase_confirmations (customer_id, created_at desc);
create index if not exists purchase_confirmations_status_idx
  on public.purchase_confirmations (status) where status in ('pending', 'confirmed');

comment on column public.purchase_confirmations.cart_hash is
  'Deterministic digest of cart_snapshot. A mismatch invalidates the confirmation.';
comment on column public.purchase_confirmations.amount_minor is
  'Authoritative total in the smallest currency unit (paise). Never from a client.';

-- ---------------------------------------------------------------------------
-- payments
--
-- Deliberately separate from orders. A payment can exist without an order
-- (attempted, failed, still unverified); an order is only ever created after a
-- payment is verified server-side.
-- ---------------------------------------------------------------------------
create table if not exists public.payments (
  id                  uuid primary key default gen_random_uuid(),
  order_id            uuid references public.orders(id) on delete set null,
  customer_id         uuid not null references public.customers(id) on delete restrict,
  confirmation_id     uuid references public.purchase_confirmations(id) on delete set null,
  provider            text not null default 'razorpay' check (provider in ('razorpay', 'mock')),
  provider_order_id   text,
  provider_payment_id text,
  amount_minor        bigint not null check (amount_minor > 0),
  currency            char(3) not null default 'INR',
  status              text not null default 'created'
                        check (status in ('created', 'pending', 'authorized', 'captured',
                                          'failed', 'cancelled', 'refunded',
                                          'verification_pending')),
  failure_reason      text,
  metadata            jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- One payment row per provider order / provider payment. This is what makes a
-- replayed webhook or a double-clicked Pay button a no-op rather than a
-- duplicate charge record.
create unique index if not exists payments_provider_order_key
  on public.payments (provider, provider_order_id) where provider_order_id is not null;
create unique index if not exists payments_provider_payment_key
  on public.payments (provider, provider_payment_id) where provider_payment_id is not null;
create index if not exists payments_customer_idx on public.payments (customer_id, created_at desc);
create index if not exists payments_order_idx on public.payments (order_id);

-- ---------------------------------------------------------------------------
-- payment_events — the money-action audit trail.
--
-- Append-only by construction: no UPDATE or DELETE path exists in the
-- application, and no browser role can read or write it at all.
-- ---------------------------------------------------------------------------
create table if not exists public.payment_events (
  id              uuid primary key default gen_random_uuid(),
  event           text not null,
  customer_id     uuid references public.customers(id) on delete set null,
  conversation_id uuid references public.conversations(id) on delete set null,
  confirmation_id uuid references public.purchase_confirmations(id) on delete set null,
  payment_id      uuid references public.payments(id) on delete set null,
  order_id        uuid references public.orders(id) on delete set null,
  amount_minor    bigint,
  currency        char(3),
  detail          jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists payment_events_customer_idx
  on public.payment_events (customer_id, created_at desc);
create index if not exists payment_events_payment_idx on public.payment_events (payment_id);

comment on table public.payment_events is
  'Append-only money-action audit trail. Never contains card data, UPI handles, keys or signatures.';

-- ---------------------------------------------------------------------------
-- webhook_events — provider event de-duplication.
-- ---------------------------------------------------------------------------
create table if not exists public.webhook_events (
  id           uuid primary key default gen_random_uuid(),
  provider     text not null default 'razorpay',
  event_id     text not null,
  event_type   text,
  payload_hash text,
  processed_at timestamptz not null default now(),
  unique (provider, event_id)
);

-- ---------------------------------------------------------------------------
-- RLS. Customers may read their own payments and confirmations, and nothing
-- else. There is no INSERT/UPDATE/DELETE policy anywhere in this file — every
-- write goes through service_role from a route handler.
-- ---------------------------------------------------------------------------
alter table public.purchase_confirmations enable row level security;
alter table public.payments               enable row level security;
alter table public.payment_events         enable row level security;
alter table public.webhook_events         enable row level security;

drop policy if exists "own confirmations readable" on public.purchase_confirmations;
create policy "own confirmations readable" on public.purchase_confirmations
  for select using (customer_id = auth.uid());

drop policy if exists "own payments readable" on public.payments;
create policy "own payments readable" on public.payments
  for select using (customer_id = auth.uid());

-- payment_events and webhook_events get RLS with NO policy at all: the audit
-- trail is not customer-readable, by design.

-- ---------------------------------------------------------------------------
-- create_order_from_cart — extended, not duplicated.
--
-- Phase 1 created orders as unpaid test orders. Phase 4 needs the same
-- transaction to also record how the order was paid for. Adding parameters
-- changes the signature, so the old one is dropped explicitly rather than left
-- behind as an overload — an ambiguous function is a security problem, not
-- just a nuisance (see 0006).
--
-- Everything else is unchanged: deterministic lock order, prices re-read from
-- the catalogue, stock verified, lines snapshotted, stock reserved, cart
-- converted — one transaction.
-- ---------------------------------------------------------------------------
drop function if exists public.create_order_from_cart(uuid, uuid, text, text, jsonb, text);

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
-- finalize_paid_payment
--
-- The single transactional step that turns a verified payment into an order.
-- Creating the order, reserving the stock, consuming the confirmation, clearing
-- the cart and flipping the payment to captured all happen together or not at
-- all — so payment, order and inventory cannot drift apart.
--
-- Idempotent: if this payment already produced an order, it returns that order
-- and changes nothing. That is what makes a replayed webhook safe.
-- ---------------------------------------------------------------------------
create or replace function public.finalize_paid_payment(
  p_payment_id          uuid,
  p_provider_payment_id text,
  p_contact_email       text,
  p_contact_phone       text,
  p_shipping_address    jsonb,
  p_notes               text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment      record;
  v_order        jsonb;
  v_order_total  numeric(12,2);
  v_expected     bigint;
begin
  -- Lock the payment row first: two concurrent webhooks for the same payment
  -- serialise here, and the second one sees the finished state.
  select * into v_payment from public.payments where id = p_payment_id for update;
  if v_payment is null then
    raise exception 'PAYMENT_NOT_FOUND';
  end if;

  -- Already finalised — return the existing order rather than creating another.
  if v_payment.order_id is not null then
    select jsonb_build_object(
             'orderId', o.id, 'orderNumber', o.order_number, 'total', o.total,
             'alreadyFinalized', true)
      into v_order
      from public.orders o where o.id = v_payment.order_id;
    return v_order;
  end if;

  -- A payment that has already failed, been cancelled or been refunded is
  -- terminal. Enforcing that here as well as in the application is deliberate:
  -- this function writes `captured` directly, so without this check a later
  -- success callback on a declined payment would quietly produce a real order.
  -- A genuine retry gets a fresh confirmation and a fresh provider order.
  if v_payment.status in ('failed', 'cancelled', 'refunded') then
    raise exception 'PAYMENT_TERMINAL:%', v_payment.status;
  end if;

  if v_payment.confirmation_id is null then
    raise exception 'NO_CONFIRMATION';
  end if;

  -- The confirmation must still be usable. A consumed one means another
  -- request got here first.
  select cart_id into v_cart_id
    from public.purchase_confirmations
   where id = v_payment.confirmation_id and status = 'confirmed'
   for update;
  if v_cart_id is null then
    raise exception 'CONFIRMATION_NOT_USABLE';
  end if;

  v_order := public.create_order_from_cart(
    v_cart_id,
    v_payment.customer_id,
    p_contact_email,
    p_contact_phone,
    p_shipping_address,
    p_notes,
    'paid',
    v_payment.provider,
    p_provider_payment_id
  );

  -- The charged amount and the order total must agree to the paise.
  v_order_total := (v_order ->> 'total')::numeric;
  v_expected    := round(v_order_total * 100)::bigint;
  if v_expected <> v_payment.amount_minor then
    raise exception 'AMOUNT_MISMATCH:%:%', v_payment.amount_minor, v_expected;
  end if;

  update public.purchase_confirmations
     set status = 'consumed', consumed_at = now(), updated_at = now()
   where id = v_payment.confirmation_id;

  update public.payments
     set status = 'captured',
         order_id = (v_order ->> 'orderId')::uuid,
         provider_payment_id = coalesce(p_provider_payment_id, provider_payment_id),
         updated_at = now()
   where id = p_payment_id;

  return v_order || jsonb_build_object('alreadyFinalized', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges. Server-side callers only — and named explicitly, because
-- REVOKE ... FROM public alone does not remove Supabase's standing grants to
-- anon and authenticated (see 0004).
-- ---------------------------------------------------------------------------
revoke execute on function
  public.create_order_from_cart(uuid, uuid, text, text, jsonb, text, text, text, text)
  from public, anon, authenticated;
revoke execute on function
  public.finalize_paid_payment(uuid, text, text, text, jsonb, text)
  from public, anon, authenticated;

grant execute on function
  public.create_order_from_cart(uuid, uuid, text, text, jsonb, text, text, text, text)
  to service_role;
grant execute on function
  public.finalize_paid_payment(uuid, text, text, text, jsonb, text)
  to service_role;
