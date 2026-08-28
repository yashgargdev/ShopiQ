-- ============================================================================
-- ShopiQ — EXECUTE privileges on functions
-- ============================================================================
-- This file is load-bearing. On Supabase, every function in the `public`
-- schema is reachable over PostgREST at /rest/v1/rpc/<name>, and default
-- privileges grant EXECUTE to `anon` and `authenticated`. A SECURITY DEFINER
-- function left at its defaults therefore runs with owner rights for anyone
-- holding the (public) anon key.
--
-- `REVOKE ... FROM public` is NOT sufficient: it revokes from the PUBLIC
-- pseudo-role and leaves the explicit anon/authenticated grants in place. Each
-- role has to be named.
--
-- Verified after applying:
--   anon → merchant_dashboard_stats  = 401 permission denied
--   anon → set_order_status          = 401 permission denied
--   anon → create_order_from_cart    = 401 permission denied
--   anon → search_products           = 200  (intended)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Public, by design. Each returns only active-catalogue data, or a fact about
-- the caller. These are the storefront's read path.
-- ---------------------------------------------------------------------------

grant execute on function public.is_merchant()                     to anon, authenticated, service_role;
grant execute on function public.get_products_stock(uuid[])         to anon, authenticated, service_role;
grant execute on function public.get_catalog_facets(text)           to anon, authenticated, service_role;
grant execute on function public.search_products(
  text, text, text[], numeric, numeric, numeric, boolean, boolean, text, integer, integer
) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Privileged. Server-side callers only — the route handlers in
-- app/api/** authorise first, then call these with the service role.
--
-- create_order_from_cart takes p_customer_id, so an exposed grant would let
-- any signed-in user place orders as somebody else. set_order_status would let
-- them ship or cancel any order. merchant_dashboard_stats exposes revenue.
-- ---------------------------------------------------------------------------

revoke execute on function public.create_order_from_cart(uuid, uuid, text, text, jsonb, text)
  from public, anon, authenticated;
revoke execute on function public.set_order_status(uuid, text)
  from public, anon, authenticated;
revoke execute on function public.merchant_dashboard_stats()
  from public, anon, authenticated;

grant execute on function public.create_order_from_cart(uuid, uuid, text, text, jsonb, text)
  to service_role;
grant execute on function public.set_order_status(uuid, text)      to service_role;
grant execute on function public.merchant_dashboard_stats()        to service_role;

-- ---------------------------------------------------------------------------
-- Trigger functions must never be callable as RPCs. Postgres checks the
-- table's TRIGGER privilege when a trigger fires, not EXECUTE on the function,
-- so revoking here does not stop the triggers from working.
-- ---------------------------------------------------------------------------

revoke execute on function public.handle_new_auth_user()           from public, anon, authenticated;
revoke execute on function public.touch_cart()                     from public, anon, authenticated;
revoke execute on function public.sync_product_specs_cache()       from public, anon, authenticated;
revoke execute on function public.products_refresh_search_vector() from public, anon, authenticated;
revoke execute on function public.ensure_inventory_row()           from public, anon, authenticated;
revoke execute on function public.set_updated_at()                 from public, anon, authenticated;
revoke execute on function public.order_stock_class(text)          from public, anon, authenticated;
