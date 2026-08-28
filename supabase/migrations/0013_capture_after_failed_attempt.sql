-- A failed ATTEMPT is not a failed order.
--
-- Razorpay Checkout lets the customer retry inside the same modal, against the
-- same provider order. The first attempt raises payment.failed, the payment row
-- moves to `failed`, and the retry then reports captured for that same order id
-- with a new payment id.
--
-- Both this function and the application layer treated `failed` as terminal, so
-- that capture was refused: the customer was charged and no order was ever
-- created. That is the worst outcome this system can produce, and it was
-- reachable by anyone whose first card attempt was declined.
--
-- Reviving is safe because of WHAT does the reviving. Every route to this
-- function verifies a Razorpay signature first — an HMAC on the callback, or a
-- signed webhook — and the amount is re-checked below against the order total.
-- A revived payment is therefore one Razorpay has cryptographically told us it
-- captured, which is independent of whatever this row happened to say first.
--
-- `cancelled` and `refunded` stay terminal: the first is a deliberate void on
-- our side, the second means the money has already gone back, so a later
-- "captured" for either is a replay rather than news.
create or replace function public.finalize_paid_payment(
  p_payment_id uuid,
  p_provider_payment_id text,
  p_contact_email text,
  p_contact_phone text,
  p_shipping_address jsonb,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_payment      record;
  v_order        jsonb;
  v_order_total  numeric(12,2);
  v_expected     bigint;
  v_cart_id      uuid;
begin
  select * into v_payment from public.payments where id = p_payment_id for update;
  if v_payment is null then
    raise exception 'PAYMENT_NOT_FOUND';
  end if;

  if v_payment.order_id is not null then
    select jsonb_build_object(
             'orderId', o.id, 'orderNumber', o.order_number, 'total', o.total,
             'alreadyFinalized', true)
      into v_order
      from public.orders o where o.id = v_payment.order_id;
    return v_order;
  end if;

  if v_payment.status in ('cancelled', 'refunded') then
    raise exception 'PAYMENT_TERMINAL:%', v_payment.status;
  end if;

  if v_payment.confirmation_id is null then
    raise exception 'NO_CONFIRMATION';
  end if;

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
$function$;
