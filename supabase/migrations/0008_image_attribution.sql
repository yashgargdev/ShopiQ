-- 0008 — attribution for third-party product imagery.
--
-- Product photography sourced from Wikimedia Commons is largely CC-BY / CC-BY-SA,
-- which requires crediting the author and naming the licence wherever the image is
-- shown. That credit is a property of the image, so it belongs on the image row.
--
-- It deliberately does NOT go in alt_text: alt_text is read aloud by screen readers
-- to describe the product, and a photographer's name is not a description.

alter table public.product_images
  add column if not exists attribution text,
  add column if not exists source_url  text,
  add column if not exists license     text;

comment on column public.product_images.attribution is
  'Author credit for third-party imagery. NULL for first-party/generated images.';
comment on column public.product_images.source_url is
  'Canonical page the image came from, for licence verification.';
comment on column public.product_images.license is
  'Short licence name, e.g. "CC BY-SA 4.0" or "Public domain".';
