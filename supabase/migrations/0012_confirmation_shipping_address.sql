-- Bind the delivery address to the thing the customer approved.
--
-- Until now the shipping address was read at FINALIZATION time, from whichever
-- address happened to be the customer's default. Two problems with that:
--
--   1. The customer was never shown it. They approved a cart and a total, and
--      the destination was decided for them afterwards. With no saved address
--      at all, order creation fell back to the literal string "Not provided" —
--      a real order, paid for, shipping nowhere.
--   2. A confirmation already binds the exact cart and the exact amount, so
--      that changing either invalidates it. The address was the one term of
--      the agreement that could still move between approval and capture.
--
-- Snapshotted, not merely referenced: an address row can be edited or deleted
-- in the ten minutes a quote is open, and the order must record what was
-- actually agreed rather than what the row says later.
alter table public.purchase_confirmations
  add column if not exists shipping_address_id uuid
    references public.customer_addresses(id) on delete set null,
  add column if not exists shipping_address jsonb;

comment on column public.purchase_confirmations.shipping_address is
  'The delivery address as it read when the customer approved this purchase. Snapshotted so a later edit or deletion cannot silently change where a paid order ships.';
