-- ============================================================================
-- ShopiQ Phase 3 — agentic cart
-- ============================================================================
-- Three additions:
--   1. cart_items.price_at_add — so checkout preparation can tell the shopper
--      "the price changed since you added this" instead of silently repricing.
--   2. conversations.pending_action — the confirmation state machine, so a
--      destructive action needs a second turn to actually run.
--   3. ai_action_keys — idempotency, so a retried tool call does not add the
--      same laptop twice.
--
-- Plus two functions that make the read-check-write of a cart mutation atomic
-- under an inventory row lock.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Price snapshot at add time
-- ---------------------------------------------------------------------------

alter table public.cart_items
  add column if not exists price_at_add numeric(12,2);

-- Backfill existing rows with today's price so nothing looks "changed" purely
-- because the column is new.
update public.cart_items ci
   set price_at_add = p.price
  from public.products p
 where p.id = ci.product_id
   and ci.price_at_add is null;

comment on column public.cart_items.price_at_add is
  'Catalogue price when the line was added. Display/warning only — the order is always priced from products.price at checkout.';

-- ---------------------------------------------------------------------------
-- 2. Pending action (the confirmation framework)
-- ---------------------------------------------------------------------------

alter table public.conversations
  add column if not exists pending_action jsonb;

comment on column public.conversations.pending_action is
  'A high-risk action awaiting explicit confirmation: { action, arguments, status, expiresAt, summary }. Phase 4 reuses this for payment.';

-- ---------------------------------------------------------------------------
-- 3. Idempotency for AI-initiated commerce actions
-- ---------------------------------------------------------------------------

create table if not exists public.ai_action_keys (
  key             text primary key,
  conversation_id uuid references public.conversations(id) on delete cascade,
  tool_name       text not null,
  result          jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists ai_action_keys_created_idx on public.ai_action_keys (created_at);

alter table public.ai_action_keys enable row level security;
-- No policy: server-side only, like ai_tool_logs.

-- ---------------------------------------------------------------------------
-- Atomic cart mutations
-- ---------------------------------------------------------------------------
-- Cart lines do not reserve stock — reservation happens in
-- create_order_from_cart(), which locks the same rows and is what actually
-- guarantees inventory can never go negative (together with the
-- reserved_quantity <= quantity check constraint).
--
-- These functions take the inventory row lock anyway so that the
-- read-availability / decide-quantity / write-line sequence is serialised.
-- Without it, two concurrent adds of the last unit could each read
-- "1 available" and both write quantity = 1 to different carts, which is
-- misleading to both shoppers even though the order path would later reject
-- one of them.

create or replace function public.cart_add_item(
  p_cart_id       uuid,
  p_product_id    uuid,
  p_quantity      integer,
  p_max_per_line  integer default 20
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
   where cart_id = p_cart_id and product_id = p_product_id;

  v_existing  := coalesce(v_existing, 0);
  v_requested := v_existing + p_quantity;
  v_applied   := least(v_requested, v_available, greatest(p_max_per_line, 1));

  if v_item_id is null then
    insert into public.cart_items (cart_id, product_id, quantity, price_at_add)
    values (p_cart_id, p_product_id, v_applied, v_price)
    returning id into v_item_id;
  else
    update public.cart_items set quantity = v_applied where id = v_item_id;
  end if;

  -- `clamped` is what lets the assistant say "only 4 were available, so I
  -- added 4" rather than reporting a quantity it did not actually set.
  return jsonb_build_object(
    'cartItemId',     v_item_id,
    'productName',    v_name,
    'previousQuantity', v_existing,
    'requestedTotal', v_requested,
    'appliedTotal',   v_applied,
    'available',      v_available,
    'clamped',        v_applied < v_requested,
    'unitPrice',      v_price
  );
end;
$$;

create or replace function public.cart_set_quantity(
  p_cart_id       uuid,
  p_cart_item_id  uuid,
  p_quantity      integer,
  p_max_per_line  integer default 20
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_product_id uuid;
  v_active     boolean;
  v_name       text;
  v_available  integer;
  v_applied    integer;
begin
  -- Ownership is part of the WHERE clause: a cart item id from another cart
  -- simply does not resolve.
  select product_id into v_product_id
    from public.cart_items
   where id = p_cart_item_id and cart_id = p_cart_id;

  if v_product_id is null then
    raise exception 'ITEM_NOT_FOUND';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    delete from public.cart_items where id = p_cart_item_id and cart_id = p_cart_id;
    return jsonb_build_object('cartItemId', p_cart_item_id, 'appliedTotal', 0, 'removed', true);
  end if;

  select p.is_active, p.name, greatest(i.quantity - i.reserved_quantity, 0)
    into v_active, v_name, v_available
    from public.products p
    join public.inventory i on i.product_id = p.id
   where p.id = v_product_id
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

  v_applied := least(p_quantity, v_available, greatest(p_max_per_line, 1));
  update public.cart_items set quantity = v_applied where id = p_cart_item_id;

  return jsonb_build_object(
    'cartItemId',     p_cart_item_id,
    'productName',    v_name,
    'requestedTotal', p_quantity,
    'appliedTotal',   v_applied,
    'available',      v_available,
    'clamped',        v_applied < p_quantity,
    'removed',        false
  );
end;
$$;

-- Server-side callers only. The route handlers resolve identity first.
revoke execute on function public.cart_add_item(uuid, uuid, integer, integer)
  from public, anon, authenticated;
revoke execute on function public.cart_set_quantity(uuid, uuid, integer, integer)
  from public, anon, authenticated;

grant execute on function public.cart_add_item(uuid, uuid, integer, integer) to service_role;
grant execute on function public.cart_set_quantity(uuid, uuid, integer, integer) to service_role;
