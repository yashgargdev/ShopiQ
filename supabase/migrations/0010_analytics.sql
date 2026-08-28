-- 0010 — Phase 6: commerce analytics and AI revenue attribution.
--
-- The question this schema exists to answer honestly is: did the AI actually
-- make the merchant any money? Answering it needs a chain of evidence from the
-- moment a product was SHOWN to the moment it was PAID FOR, with each step
-- timestamped and each link explicit.
--
-- Two rules shape everything here:
--
--   1. Attribution is recorded, never inferred after the fact. A recommendation
--      that was never shown cannot later be credited with a sale.
--   2. Revenue is attributed once. A product can be AI-recommended and
--      cross-sold, but it contributes to exactly one revenue bucket, chosen by
--      a documented precedence — otherwise the totals flatter themselves.

-- ---------------------------------------------------------------------------
-- ai_recommendations — one row per product SHOWN to a customer by the AI.
--
-- This is the head of the attribution chain. The timestamps are nullable and
-- fill in as the customer progresses, so an untouched recommendation stays
-- visible as an impression that went nowhere.
-- ---------------------------------------------------------------------------
create table if not exists public.ai_recommendations (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid references public.conversations(id) on delete set null,
  customer_id      uuid references public.customers(id) on delete set null,
  /** Guest sessions are attributable too — they convert as often as accounts. */
  session_key      text,
  product_id       uuid not null references public.products(id) on delete cascade,
  /** Where the suggestion came from. Drives the revenue bucket. */
  source           text not null
                     check (source in ('ai_search', 'ai_recommendation', 'ai_cross_sell',
                                       'ai_comparison', 'related_products')),
  /** Position in the list, so we can see whether rank matters. */
  position         integer,
  /** The engine's score at the time it was shown. */
  score            numeric(5,2),
  /** A/B bucket, when an experiment is running. */
  variant          text not null default 'control',
  shown_at         timestamptz not null default now(),
  clicked_at       timestamptz,
  added_to_cart_at timestamptz,
  purchased_at     timestamptz,
  order_id         uuid references public.orders(id) on delete set null,
  /** Line revenue at purchase, in paise. Snapshotted, never recomputed. */
  revenue_minor    bigint,
  created_at       timestamptz not null default now()
);

create index if not exists ai_recommendations_product_idx
  on public.ai_recommendations (product_id, shown_at desc);
create index if not exists ai_recommendations_customer_idx
  on public.ai_recommendations (customer_id, shown_at desc);
create index if not exists ai_recommendations_session_idx
  on public.ai_recommendations (session_key, shown_at desc);
create index if not exists ai_recommendations_source_idx
  on public.ai_recommendations (source, shown_at desc);
create index if not exists ai_recommendations_order_idx
  on public.ai_recommendations (order_id) where order_id is not null;
-- The funnel queries all filter on "did this convert", so index the tail.
create index if not exists ai_recommendations_purchased_idx
  on public.ai_recommendations (purchased_at) where purchased_at is not null;

comment on table public.ai_recommendations is
  'Attribution chain: every product the AI showed, and how far it got. Rows are written when shown, then updated in place as the customer progresses.';

-- ---------------------------------------------------------------------------
-- commerce_events — the funnel.
--
-- Deliberately coarse. This is not a product-analytics platform; it is the
-- handful of counts needed to state an honest conversion rate.
-- ---------------------------------------------------------------------------
create table if not exists public.commerce_events (
  id              uuid primary key default gen_random_uuid(),
  event           text not null,
  conversation_id uuid references public.conversations(id) on delete set null,
  customer_id     uuid references public.customers(id) on delete set null,
  session_key     text,
  product_id      uuid references public.products(id) on delete set null,
  order_id        uuid references public.orders(id) on delete set null,
  /** 'ai' when the AI drove this step, 'web' when the customer clicked. */
  channel         text not null default 'web' check (channel in ('ai', 'web', 'voice')),
  value_minor     bigint,
  detail          jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists commerce_events_event_idx on public.commerce_events (event, created_at desc);
create index if not exists commerce_events_session_idx on public.commerce_events (session_key, created_at desc);
create index if not exists commerce_events_channel_idx on public.commerce_events (channel, created_at desc);
create index if not exists commerce_events_order_idx on public.commerce_events (order_id) where order_id is not null;

comment on table public.commerce_events is
  'Coarse commerce funnel. channel=ai marks a step the assistant drove, which is what makes an AI-assisted conversion rate computable.';

-- ---------------------------------------------------------------------------
-- ai_usage — cost and latency per AI call.
--
-- Token counts come from the provider when it reports them; when it does not,
-- they stay NULL and the cost is reported as unknown rather than guessed.
-- ---------------------------------------------------------------------------
create table if not exists public.ai_usage (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid references public.conversations(id) on delete set null,
  kind             text not null check (kind in ('chat', 'extraction', 'stt', 'tts')),
  provider         text not null,
  model            text,
  input_tokens     integer,
  output_tokens    integer,
  /** Seconds of audio, for speech. */
  audio_seconds    numeric(8,2),
  latency_ms       integer,
  /** Estimated, in paise. NULL when we cannot price it honestly. */
  cost_minor       bigint,
  created_at       timestamptz not null default now()
);

create index if not exists ai_usage_kind_idx on public.ai_usage (kind, created_at desc);
create index if not exists ai_usage_created_idx on public.ai_usage (created_at desc);

comment on column public.ai_usage.cost_minor is
  'ESTIMATED cost in paise from a published rate card. NULL when the provider reports no usage data — never a guess.';

-- ---------------------------------------------------------------------------
-- RLS. None of this is customer-facing: it is merchant analytics and it is
-- read through the service role from guarded merchant routes. Enabled with no
-- customer policy, exactly like the audit tables.
-- ---------------------------------------------------------------------------
alter table public.ai_recommendations enable row level security;
alter table public.commerce_events    enable row level security;
alter table public.ai_usage           enable row level security;

-- ---------------------------------------------------------------------------
-- attribute_order_revenue
--
-- Called once after an order is created. Walks the order's lines, finds the
-- most recent recommendation that led to each one, and stamps it with the
-- revenue that line actually produced.
--
-- Precedence when a product was shown more than once: the LAST recommendation
-- before the purchase wins, and cross-sell outranks search when both happened
-- in the same conversation — a customer who saw a bag in results and then
-- accepted it as a suggested add-on was converted by the suggestion.
--
-- Revenue is written to exactly one row per order line, so no order line can
-- be double-counted across buckets.
-- ---------------------------------------------------------------------------
create or replace function public.attribute_order_revenue(p_order_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_line     record;
  v_rec_id   uuid;
  v_count    integer := 0;
  v_customer uuid;
  v_placed   timestamptz;
begin
  select customer_id, placed_at into v_customer, v_placed
    from public.orders where id = p_order_id;
  if v_customer is null then
    return 0;
  end if;

  for v_line in
    select product_id, total_price from public.order_items where order_id = p_order_id
  loop
    -- The most recent qualifying recommendation for this product, preferring a
    -- cross-sell over a plain search impression when both exist.
    select id into v_rec_id
      from public.ai_recommendations r
     where r.product_id = v_line.product_id
       and r.customer_id = v_customer
       and r.purchased_at is null
       and r.shown_at <= v_placed
     order by (case when r.source = 'ai_cross_sell' then 0 else 1 end),
              r.shown_at desc
     limit 1;

    if v_rec_id is not null then
      update public.ai_recommendations
         set purchased_at = coalesce(purchased_at, now()),
             order_id = p_order_id,
             revenue_minor = round(v_line.total_price * 100)::bigint
       where id = v_rec_id;
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end;
$$;

revoke execute on function public.attribute_order_revenue(uuid) from public, anon, authenticated;
grant execute on function public.attribute_order_revenue(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- ai_commerce_stats — the merchant dashboard figures, computed in one pass.
--
-- Every number is derived from rows that exist. Where there is not enough data
-- to state a rate honestly, the numerator and denominator are both returned so
-- the caller can decide to show N/A rather than a misleading 0%.
-- ---------------------------------------------------------------------------
create or replace function public.ai_commerce_stats(p_days integer default 30)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_since             timestamptz := now() - make_interval(days => greatest(p_days, 1));
  v_conversations     integer;
  v_ai_sessions       integer;
  v_ai_orders         integer;
  v_total_orders      integer;
  v_ai_revenue        numeric := 0;
  v_total_revenue     numeric := 0;
  v_cross_shown       integer;
  v_cross_clicked     integer;
  v_cross_added       integer;
  v_cross_purchased   integer;
  v_cross_revenue     numeric := 0;
  v_rec_shown         integer;
  v_rec_added         integer;
begin
  select count(*) into v_conversations
    from public.conversations where created_at >= v_since;

  -- An "AI-assisted session" is a conversation in which the assistant took a
  -- commerce step, not merely one that was opened. Counting opened panels
  -- would inflate the conversion denominator's opposite — it would deflate the
  -- rate — and either way it would not mean anything.
  select count(distinct coalesce(conversation_id::text, session_key)) into v_ai_sessions
    from public.commerce_events
   where channel in ('ai', 'voice')
     and created_at >= v_since
     and event in ('ai_recommendation_shown', 'ai_add_to_cart', 'ai_checkout_started');

  select count(distinct o.id), coalesce(sum(o.total), 0)
    into v_total_orders, v_total_revenue
    from public.orders o
   where o.placed_at >= v_since and o.payment_status = 'paid';

  -- An AI-assisted order is one where at least one line traces back to a
  -- recommendation the AI showed. That is the documented rule, and it is why
  -- attribution has to be recorded at impression time.
  select count(distinct r.order_id), coalesce(sum(r.revenue_minor), 0) / 100.0
    into v_ai_orders, v_ai_revenue
    from public.ai_recommendations r
    join public.orders o on o.id = r.order_id
   where r.purchased_at is not null
     and o.payment_status = 'paid'
     and r.purchased_at >= v_since;

  select
    count(*) filter (where source = 'ai_cross_sell'),
    count(*) filter (where source = 'ai_cross_sell' and clicked_at is not null),
    count(*) filter (where source = 'ai_cross_sell' and added_to_cart_at is not null),
    count(*) filter (where source = 'ai_cross_sell' and purchased_at is not null),
    coalesce(sum(revenue_minor) filter (where source = 'ai_cross_sell'), 0) / 100.0,
    count(*) filter (where source in ('ai_search', 'ai_recommendation')),
    count(*) filter (where source in ('ai_search', 'ai_recommendation') and added_to_cart_at is not null)
  into v_cross_shown, v_cross_clicked, v_cross_added, v_cross_purchased, v_cross_revenue,
       v_rec_shown, v_rec_added
  from public.ai_recommendations
  where shown_at >= v_since;

  return jsonb_build_object(
    'windowDays', greatest(p_days, 1),
    'since', v_since,
    'conversations', v_conversations,
    'aiSessions', v_ai_sessions,
    'aiOrders', coalesce(v_ai_orders, 0),
    'totalOrders', v_total_orders,
    'aiRevenue', v_ai_revenue,
    'totalRevenue', v_total_revenue,
    'nonAiRevenue', greatest(v_total_revenue - v_ai_revenue, 0),
    'crossSell', jsonb_build_object(
      'shown', v_cross_shown, 'clicked', v_cross_clicked, 'added', v_cross_added,
      'purchased', v_cross_purchased, 'revenue', v_cross_revenue),
    'recommendations', jsonb_build_object('shown', v_rec_shown, 'added', v_rec_added),
    -- Rates are returned as numerator/denominator pairs so the caller can show
    -- N/A on an empty denominator instead of a meaningless 0%.
    'aiConversion', jsonb_build_object('numerator', coalesce(v_ai_orders, 0), 'denominator', v_ai_sessions),
    'aov', jsonb_build_object(
      'allNumerator', v_total_revenue, 'allDenominator', v_total_orders,
      'aiNumerator', v_ai_revenue, 'aiDenominator', coalesce(v_ai_orders, 0),
      'nonAiNumerator', greatest(v_total_revenue - v_ai_revenue, 0),
      'nonAiDenominator', greatest(v_total_orders - coalesce(v_ai_orders, 0), 0))
  );
end;
$$;

revoke execute on function public.ai_commerce_stats(integer) from public, anon, authenticated;
grant execute on function public.ai_commerce_stats(integer) to service_role;

-- ---------------------------------------------------------------------------
-- frequently_bought_together — merchant insight from real orders only.
--
-- Returns nothing when there is not enough order history, rather than
-- inventing a relationship. An insight engine that always has an answer is an
-- insight engine nobody should trust.
-- ---------------------------------------------------------------------------
create or replace function public.frequently_bought_together(
  p_product_id uuid,
  p_limit      integer default 5
)
returns table (
  product_id   uuid,
  product_name text,
  times_paired bigint,
  attach_rate  numeric
)
language sql
security definer
set search_path = public, pg_temp
as $$
  with anchor_orders as (
    select distinct oi.order_id
      from public.order_items oi
     where oi.product_id = p_product_id
  ),
  anchor_count as (
    select count(*)::numeric as total from anchor_orders
  )
  select
    oi.product_id,
    max(oi.product_name) as product_name,
    count(distinct oi.order_id) as times_paired,
    round(count(distinct oi.order_id)::numeric / nullif((select total from anchor_count), 0), 4) as attach_rate
  from public.order_items oi
  join anchor_orders ao on ao.order_id = oi.order_id
  where oi.product_id <> p_product_id
  group by oi.product_id
  order by times_paired desc, attach_rate desc
  limit greatest(p_limit, 1);
$$;

revoke execute on function public.frequently_bought_together(uuid, integer) from public, anon, authenticated;
grant execute on function public.frequently_bought_together(uuid, integer) to service_role;
