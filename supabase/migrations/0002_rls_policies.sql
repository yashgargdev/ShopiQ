-- ============================================================================
-- ShopiQ — Row Level Security
-- ============================================================================
-- Access model
--   anon / authenticated  → read the active catalogue only
--   authenticated         → full access to their OWN cart, orders and profile
--   merchant_users        → manage catalogue, inventory and every order
--   guest carts           → never reachable from the browser. They are keyed by
--                           an httpOnly cookie token and only ever touched by
--                           server-side code holding the service role key.
-- ============================================================================

-- is_merchant() is SECURITY DEFINER so it can read merchant_users without
-- recursing back into that table's own RLS policies.
create or replace function public.is_merchant()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.merchant_users m
     where m.id = auth.uid() and m.is_active
  );
$$;

revoke all on function public.is_merchant() from public;
grant execute on function public.is_merchant() to anon, authenticated, service_role;

alter table public.categories         enable row level security;
alter table public.products           enable row level security;
alter table public.product_images     enable row level security;
alter table public.product_specs      enable row level security;
alter table public.inventory          enable row level security;
alter table public.customers          enable row level security;
alter table public.customer_addresses enable row level security;
alter table public.merchant_users     enable row level security;
alter table public.carts              enable row level security;
alter table public.cart_items         enable row level security;
alter table public.orders             enable row level security;
alter table public.order_items        enable row level security;

-- ---------------------------------------------------------------------------
-- Catalogue: world-readable while active, merchant-writable
-- ---------------------------------------------------------------------------

create policy categories_public_read on public.categories
  for select to anon, authenticated
  using (is_active or public.is_merchant());

create policy categories_merchant_write on public.categories
  for all to authenticated
  using (public.is_merchant()) with check (public.is_merchant());

create policy products_public_read on public.products
  for select to anon, authenticated
  using (is_active or public.is_merchant());

create policy products_merchant_write on public.products
  for all to authenticated
  using (public.is_merchant()) with check (public.is_merchant());

create policy product_images_public_read on public.product_images
  for select to anon, authenticated
  using (
    public.is_merchant()
    or exists (select 1 from public.products p where p.id = product_id and p.is_active)
  );

create policy product_images_merchant_write on public.product_images
  for all to authenticated
  using (public.is_merchant()) with check (public.is_merchant());

create policy product_specs_public_read on public.product_specs
  for select to anon, authenticated
  using (
    public.is_merchant()
    or exists (select 1 from public.products p where p.id = product_id and p.is_active)
  );

create policy product_specs_merchant_write on public.product_specs
  for all to authenticated
  using (public.is_merchant()) with check (public.is_merchant());

-- ---------------------------------------------------------------------------
-- Inventory: never readable directly by shoppers.
-- Storefront availability goes through public.get_products_stock(), which
-- returns only what the UI needs and hides reserved_quantity.
-- ---------------------------------------------------------------------------

create policy inventory_merchant_read on public.inventory
  for select to authenticated
  using (public.is_merchant());

create policy inventory_merchant_write on public.inventory
  for all to authenticated
  using (public.is_merchant()) with check (public.is_merchant());

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

create policy customers_self_read on public.customers
  for select to authenticated using (id = auth.uid());

create policy customers_self_update on public.customers
  for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy addresses_self_all on public.customer_addresses
  for all to authenticated
  using (customer_id = auth.uid()) with check (customer_id = auth.uid());

create policy merchant_users_self_read on public.merchant_users
  for select to authenticated
  using (id = auth.uid() or public.is_merchant());

-- ---------------------------------------------------------------------------
-- Carts: signed-in shoppers only. Guest carts have customer_id IS NULL and are
-- therefore invisible to every browser-side role.
-- ---------------------------------------------------------------------------

create policy carts_owner_all on public.carts
  for all to authenticated
  using (customer_id is not null and customer_id = auth.uid())
  with check (customer_id is not null and customer_id = auth.uid());

create policy cart_items_owner_all on public.cart_items
  for all to authenticated
  using (exists (
    select 1 from public.carts c
     where c.id = cart_id and c.customer_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.carts c
     where c.id = cart_id and c.customer_id = auth.uid()
  ));

-- ---------------------------------------------------------------------------
-- Orders: a shopper sees only their own. Orders are never INSERTed from a
-- browser session — public.create_order_from_cart() is the only writer, so
-- prices and stock are always validated server-side.
-- ---------------------------------------------------------------------------

create policy orders_owner_read on public.orders
  for select to authenticated
  using (customer_id = auth.uid() or public.is_merchant());

create policy orders_merchant_update on public.orders
  for update to authenticated
  using (public.is_merchant()) with check (public.is_merchant());

create policy order_items_owner_read on public.order_items
  for select to authenticated
  using (
    public.is_merchant()
    or exists (
      select 1 from public.orders o
       where o.id = order_id and o.customer_id = auth.uid()
    )
  );
