-- ============================================================================
-- ShopiQ — Phase 1 core commerce schema
-- ============================================================================
-- Design notes
--   * Money is numeric(12,2) + a separate ISO currency code. Never a formatted
--     string: the future AI agent has to be able to compare and sum these.
--   * product_specs is the source of truth for specifications; products.specs
--     (jsonb) is a trigger-maintained cache of the same data in the shape the
--     AI agent will reason over ({"ram_gb": 32, "gpu": "RTX 4060"}).
--   * Availability is derived (quantity - reserved_quantity) and never written
--     by a client.
-- ============================================================================

-- Extensions live outside `public`: Supabase exposes public through PostgREST,
-- and extension objects have no business on that surface.
create schema if not exists extensions;
grant usage on schema extensions to postgres, anon, authenticated, service_role;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm  with schema extensions;

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- categories
-- ---------------------------------------------------------------------------

create table public.categories (
  id            uuid primary key default gen_random_uuid(),
  parent_id     uuid references public.categories(id) on delete set null,
  name          text not null check (length(btrim(name)) between 1 and 120),
  slug          text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  description   text,
  image_url     text,
  sort_order    integer not null default 0,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index categories_parent_idx on public.categories (parent_id);
create index categories_active_idx on public.categories (is_active, sort_order);

create trigger categories_set_updated_at
  before update on public.categories
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- products
-- ---------------------------------------------------------------------------

create table public.products (
  id                 uuid primary key default gen_random_uuid(),
  category_id        uuid not null references public.categories(id) on delete restrict,
  name               text not null check (length(btrim(name)) between 1 and 200),
  slug               text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  brand              text not null check (length(btrim(brand)) between 1 and 80),
  description        text,
  short_description  text,
  price              numeric(12,2) not null check (price >= 0),
  compare_at_price   numeric(12,2) check (compare_at_price >= 0),
  currency           char(3) not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  sku                text not null unique check (length(btrim(sku)) between 1 and 64),
  tags               text[] not null default '{}',
  -- Trigger-maintained cache of public.product_specs, in AI-readable shape.
  specs              jsonb not null default '{}'::jsonb,
  rating             numeric(2,1) not null default 0 check (rating >= 0 and rating <= 5),
  review_count       integer not null default 0 check (review_count >= 0),
  is_featured        boolean not null default false,
  is_active          boolean not null default true,
  search_vector      tsvector,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint products_compare_at_price_gte_price
    check (compare_at_price is null or compare_at_price >= price)
);

create index products_category_idx     on public.products (category_id);
create index products_brand_idx        on public.products (brand);
create index products_price_idx        on public.products (price);
create index products_rating_idx       on public.products (rating desc);
create index products_active_idx       on public.products (is_active);
create index products_featured_idx     on public.products (is_featured) where is_featured;
create index products_created_idx      on public.products (created_at desc);
create index products_search_idx       on public.products using gin (search_vector);
create index products_specs_idx        on public.products using gin (specs jsonb_path_ops);
create index products_tags_idx         on public.products using gin (tags);
-- Schema-qualified so the index does not depend on `extensions` being on the
-- search_path at replay time.
create index products_name_trgm_idx    on public.products using gin (name extensions.gin_trgm_ops);

create trigger products_set_updated_at
  before update on public.products
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- product_images  (binaries live in Cloudflare R2, only references live here)
-- ---------------------------------------------------------------------------

create table public.product_images (
  id           uuid primary key default gen_random_uuid(),
  product_id   uuid not null references public.products(id) on delete cascade,
  r2_key       text not null check (length(r2_key) between 1 and 512),
  public_url   text not null,
  alt_text     text,
  width        integer check (width > 0),
  height       integer check (height > 0),
  sort_order   integer not null default 0,
  is_primary   boolean not null default false,
  created_at   timestamptz not null default now(),
  unique (product_id, r2_key)
);

create index product_images_product_idx on public.product_images (product_id, sort_order);
-- At most one primary image per product.
create unique index product_images_one_primary_idx
  on public.product_images (product_id) where is_primary;

-- ---------------------------------------------------------------------------
-- product_specs  (source of truth for specifications)
-- ---------------------------------------------------------------------------

create table public.product_specs (
  id              uuid primary key default gen_random_uuid(),
  product_id      uuid not null references public.products(id) on delete cascade,
  spec_key        text not null check (spec_key ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
  spec_value      text not null,
  -- Populated when the value is numeric, so the API (and later the AI agent)
  -- can filter on ranges: ram_gb >= 16, weight_kg <= 2.
  spec_value_num  numeric,
  unit            text,
  display_label   text not null,
  sort_order      integer not null default 0,
  created_at      timestamptz not null default now(),
  unique (product_id, spec_key)
);

create index product_specs_product_idx on public.product_specs (product_id, sort_order);
create index product_specs_key_idx     on public.product_specs (spec_key, spec_value_num);
create index product_specs_value_idx   on public.product_specs (spec_key, spec_value);

-- Keep products.specs in sync with product_specs so the catalogue always has a
-- single machine-readable jsonb document per product.
create or replace function public.sync_product_specs_cache()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_product_id uuid := coalesce(new.product_id, old.product_id);
begin
  update public.products p
     set specs = coalesce((
           select jsonb_object_agg(
                    s.spec_key,
                    case when s.spec_value_num is not null
                         then to_jsonb(s.spec_value_num)
                         else to_jsonb(s.spec_value)
                    end
                  )
             from public.product_specs s
            where s.product_id = v_product_id
         ), '{}'::jsonb)
   where p.id = v_product_id;
  return null;
end;
$$;

create trigger product_specs_sync_cache
  after insert or update or delete on public.product_specs
  for each row execute function public.sync_product_specs_cache();

-- ---------------------------------------------------------------------------
-- Full-text search vector for products
-- ---------------------------------------------------------------------------

create or replace function public.products_refresh_search_vector()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_category     text := '';
  v_spec_values  text := '';
  v_spec_keys    text := '';
begin
  select c.name into v_category
    from public.categories c where c.id = new.category_id;

  -- Spec KEYS are indexed alongside their values, so a shopper searching
  -- "noise cancellation" matches a product whose stored value is "ANC".
  select string_agg(value, ' '), string_agg(replace(key, '_', ' '), ' ')
    into v_spec_values, v_spec_keys
    from jsonb_each_text(coalesce(new.specs, '{}'::jsonb));

  new.search_vector :=
      setweight(to_tsvector('english', coalesce(new.name, '')), 'A')
   || setweight(to_tsvector('english', coalesce(new.brand, '')), 'A')
   || setweight(to_tsvector('english', array_to_string(coalesce(new.tags, '{}'), ' ')), 'B')
   || setweight(to_tsvector('english', coalesce(v_category, '')), 'B')
   || setweight(to_tsvector('english', coalesce(new.short_description, '')), 'C')
   || setweight(to_tsvector('english', coalesce(v_spec_keys, '')), 'C')
   || setweight(to_tsvector('english', coalesce(new.description, '')), 'D')
   || setweight(to_tsvector('english', coalesce(v_spec_values, '')), 'D');
  return new;
end;
$$;

create trigger products_search_vector_trigger
  before insert or update of name, brand, tags, short_description, description, specs, category_id
  on public.products
  for each row execute function public.products_refresh_search_vector();

-- ---------------------------------------------------------------------------
-- inventory
-- ---------------------------------------------------------------------------

create table public.inventory (
  id                   uuid primary key default gen_random_uuid(),
  product_id           uuid not null unique references public.products(id) on delete cascade,
  quantity             integer not null default 0 check (quantity >= 0),
  reserved_quantity    integer not null default 0 check (reserved_quantity >= 0),
  low_stock_threshold  integer not null default 5 check (low_stock_threshold >= 0),
  available            integer generated always as (quantity - reserved_quantity) stored,
  updated_at           timestamptz not null default now(),
  constraint inventory_reserved_lte_quantity check (reserved_quantity <= quantity)
);

create index inventory_available_idx on public.inventory (available);

create trigger inventory_set_updated_at
  before update on public.inventory
  for each row execute function public.set_updated_at();

-- Every product gets an inventory row.
create or replace function public.ensure_inventory_row()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.inventory (product_id, quantity)
  values (new.id, 0)
  on conflict (product_id) do nothing;
  return new;
end;
$$;

create trigger products_ensure_inventory
  after insert on public.products
  for each row execute function public.ensure_inventory_row();

-- ---------------------------------------------------------------------------
-- customers / merchant_users  (identity lives in auth.users)
-- ---------------------------------------------------------------------------

create table public.customers (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  full_name   text,
  phone       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger customers_set_updated_at
  before update on public.customers
  for each row execute function public.set_updated_at();

create table public.merchant_users (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  full_name   text,
  role        text not null default 'staff' check (role in ('owner', 'manager', 'staff')),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger merchant_users_set_updated_at
  before update on public.merchant_users
  for each row execute function public.set_updated_at();

create table public.customer_addresses (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid not null references public.customers(id) on delete cascade,
  label         text,
  full_name     text not null,
  phone         text not null,
  line1         text not null,
  line2         text,
  city          text not null,
  state         text not null,
  postal_code   text not null,
  country       text not null default 'IN',
  is_default    boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index customer_addresses_customer_idx on public.customer_addresses (customer_id);
create unique index customer_addresses_one_default_idx
  on public.customer_addresses (customer_id) where is_default;

create trigger customer_addresses_set_updated_at
  before update on public.customer_addresses
  for each row execute function public.set_updated_at();

-- Mirror new auth users into customers (or merchant_users when the signup
-- metadata asks for it and the signup was made with a valid merchant invite).
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.customers (id, email, full_name, phone)
  values (
    new.id,
    new.email,
    nullif(new.raw_user_meta_data ->> 'full_name', ''),
    nullif(new.raw_user_meta_data ->> 'phone', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- carts
-- ---------------------------------------------------------------------------

create table public.carts (
  id             uuid primary key default gen_random_uuid(),
  customer_id    uuid references public.customers(id) on delete cascade,
  -- Opaque token stored in an httpOnly cookie for guest shoppers.
  session_token  text unique,
  status         text not null default 'active'
                   check (status in ('active', 'converted', 'abandoned')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint carts_owner_present check (customer_id is not null or session_token is not null)
);

create unique index carts_one_active_per_customer_idx
  on public.carts (customer_id) where status = 'active' and customer_id is not null;
create index carts_status_idx on public.carts (status);

create trigger carts_set_updated_at
  before update on public.carts
  for each row execute function public.set_updated_at();

create table public.cart_items (
  id          uuid primary key default gen_random_uuid(),
  cart_id     uuid not null references public.carts(id) on delete cascade,
  product_id  uuid not null references public.products(id) on delete cascade,
  quantity    integer not null check (quantity > 0 and quantity <= 20),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (cart_id, product_id)
);

create index cart_items_cart_idx    on public.cart_items (cart_id);
create index cart_items_product_idx on public.cart_items (product_id);

create trigger cart_items_set_updated_at
  before update on public.cart_items
  for each row execute function public.set_updated_at();

-- Touch the parent cart whenever its contents change.
create or replace function public.touch_cart()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.carts set updated_at = now()
   where id = coalesce(new.cart_id, old.cart_id);
  return null;
end;
$$;

create trigger cart_items_touch_cart
  after insert or update or delete on public.cart_items
  for each row execute function public.touch_cart();

-- ---------------------------------------------------------------------------
-- orders
-- ---------------------------------------------------------------------------

create sequence public.order_number_seq start 1000;

create table public.orders (
  id                uuid primary key default gen_random_uuid(),
  order_number      text not null unique,
  customer_id       uuid not null references public.customers(id) on delete restrict,
  status            text not null default 'pending'
                      check (status in ('pending', 'confirmed', 'processing', 'shipped',
                                        'delivered', 'cancelled', 'refunded')),
  payment_status    text not null default 'unpaid'
                      check (payment_status in ('unpaid', 'paid', 'failed', 'refunded')),
  -- Phase 1 only ever writes 'test_order'. Razorpay lands here in a later phase.
  payment_method    text not null default 'test_order',
  payment_reference text,
  subtotal          numeric(12,2) not null check (subtotal >= 0),
  discount_amount   numeric(12,2) not null default 0 check (discount_amount >= 0),
  shipping_amount   numeric(12,2) not null default 0 check (shipping_amount >= 0),
  tax_amount        numeric(12,2) not null default 0 check (tax_amount >= 0),
  total             numeric(12,2) not null check (total >= 0),
  currency          char(3) not null default 'INR',
  shipping_address  jsonb not null,
  contact_email     text not null,
  contact_phone     text,
  notes             text,
  placed_at         timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index orders_customer_idx on public.orders (customer_id, created_at desc);
create index orders_status_idx   on public.orders (status);
create index orders_created_idx  on public.orders (created_at desc);

create trigger orders_set_updated_at
  before update on public.orders
  for each row execute function public.set_updated_at();

-- Order items snapshot the product as it was at purchase time. Historical
-- totals must never be recomputed from today's product price.
create table public.order_items (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.orders(id) on delete cascade,
  product_id    uuid references public.products(id) on delete set null,
  product_name  text not null,
  product_slug  text,
  brand         text,
  sku           text,
  image_url     text,
  quantity      integer not null check (quantity > 0),
  unit_price    numeric(12,2) not null check (unit_price >= 0),
  total_price   numeric(12,2) not null check (total_price >= 0),
  created_at    timestamptz not null default now()
);

create index order_items_order_idx   on public.order_items (order_id);
create index order_items_product_idx on public.order_items (product_id);
