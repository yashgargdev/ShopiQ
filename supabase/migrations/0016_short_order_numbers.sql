-- Short, human order numbers: YYMM + a sequence that restarts each month.
--
-- "SQ-2026-1042" is fourteen characters to read down a phone line and carries a
-- global sequence that quietly discloses how many orders ShopiQ has ever taken.
-- "#2609001" is the year, the month, and the order's place within that month —
-- short enough to say aloud, and enough to find the order.
--
-- The '#' is display only. Stored values are bare digits so that a customer
-- typing "2609001", "#2609001" or "order 2609001" all match the same row after
-- the caller strips punctuation.

create table if not exists public.order_number_counters (
  -- 'YYMM' — one row per month, created on first use.
  period      text primary key,
  next_value  integer not null default 0,
  updated_at  timestamptz not null default now()
);

-- Nobody reaches this directly. It is written only by next_order_number(),
-- which runs as the definer inside order creation.
alter table public.order_number_counters enable row level security;

comment on table public.order_number_counters is
  'Per-month order number sequence. Written only by public.next_order_number().';

/**
 * The next order number, as YYMM + a zero-padded sequence.
 *
 * The counter is bumped with a single INSERT .. ON CONFLICT DO UPDATE, so two
 * orders placed in the same instant get different numbers: the row is locked
 * for the duration of the update, and the second waits rather than reading a
 * stale value. Counting existing orders instead would race, and order_number
 * is UNIQUE — the loser of that race would not get a slow number, it would get
 * a failed checkout.
 *
 * The month comes from Asia/Kolkata rather than UTC so that an order placed at
 * 11pm on the 31st carries the month the customer placed it in.
 *
 * Past 999 orders in one month lpad simply stops padding and the number grows a
 * digit (2609)1000. Longer than intended, still unique, still correct — which
 * is the right way for this to degrade.
 */
create or replace function public.next_order_number()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_period text := to_char(now() at time zone 'Asia/Kolkata', 'YYMM');
  v_seq    integer;
begin
  insert into public.order_number_counters as c (period, next_value)
  values (v_period, 1)
  on conflict (period) do update
    set next_value = c.next_value + 1,
        updated_at = now()
  returning c.next_value into v_seq;

  return v_period || lpad(v_seq::text, 3, '0');
end;
$$;

revoke all on function public.next_order_number() from public, anon, authenticated;
grant execute on function public.next_order_number() to service_role;

-- Seed the current month past any short numbers that already exist, so the
-- first new order cannot collide with one created before this migration.
insert into public.order_number_counters (period, next_value)
select to_char(now() at time zone 'Asia/Kolkata', 'YYMM'),
       coalesce(max(substring(order_number from 5)::integer), 0)
  from public.orders
 where order_number ~ ('^' || to_char(now() at time zone 'Asia/Kolkata', 'YYMM') || '[0-9]+$')
on conflict (period) do nothing;
