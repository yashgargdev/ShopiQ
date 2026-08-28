'use client';

import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import { CheckIcon, CloseIcon, PlusIcon, UploadIcon } from '@/components/ui/icons';
import { Button, InlineAlert } from '@/components/ui/primitives';
import { cx, slugify } from '@/lib/format';
import type { CategoryRef } from '@/types';

/**
 * Create / edit a product.
 *
 * Specifications are edited as typed key–label–value rows. A value that parses
 * as a number is stored as a number, which is what lets the catalogue answer
 * "at least 16 GB of RAM" — and what the Phase 2 agent will reason over.
 *
 * Images upload straight to Cloudflare R2 through the server route; the
 * browser never holds an R2 credential.
 */

export interface SpecRow {
  key: string;
  label: string;
  value: string;
  unit: string;
}

export interface ExistingImage {
  id: string;
  public_url: string;
  alt_text: string | null;
  is_primary: boolean;
}

export interface ProductFormValues {
  id?: string;
  name: string;
  brand: string;
  categoryId: string;
  sku: string;
  price: string;
  compareAtPrice: string;
  shortDescription: string;
  description: string;
  tags: string;
  rating: string;
  reviewCount: string;
  isFeatured: boolean;
  isActive: boolean;
  quantity: string;
  lowStockThreshold: string;
  specs: SpecRow[];
}

export const EMPTY_PRODUCT: ProductFormValues = {
  name: '',
  brand: '',
  categoryId: '',
  sku: '',
  price: '',
  compareAtPrice: '',
  shortDescription: '',
  description: '',
  tags: '',
  rating: '0',
  reviewCount: '0',
  isFeatured: false,
  isActive: true,
  quantity: '0',
  lowStockThreshold: '5',
  specs: [],
};

export function ProductForm({
  mode,
  categories,
  initial,
  images = [],
}: {
  mode: 'create' | 'edit';
  categories: CategoryRef[];
  initial: ProductFormValues;
  images?: ExistingImage[];
}) {
  const router = useRouter();
  const [form, setForm] = useState<ProductFormValues>(initial);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const set =
    <K extends keyof ProductFormValues>(key: K) =>
    (value: ProductFormValues[K]) => {
      setForm((current) => ({ ...current, [key]: value }));
      setFieldErrors((current) => ({ ...current, [String(key)]: '' }));
      setError(null);
      setSaved(false);
    };

  const addSpec = () =>
    setForm((current) => ({
      ...current,
      specs: [...current.specs, { key: '', label: '', value: '', unit: '' }],
    }));

  const updateSpec = (index: number, patch: Partial<SpecRow>) =>
    setForm((current) => ({
      ...current,
      specs: current.specs.map((spec, i) => (i === index ? { ...spec, ...patch } : spec)),
    }));

  const removeSpec = (index: number) =>
    setForm((current) => ({
      ...current,
      specs: current.specs.filter((_, i) => i !== index),
    }));

  const buildPayload = () => ({
    name: form.name.trim(),
    slug: slugify(form.name),
    brand: form.brand.trim(),
    categoryId: form.categoryId,
    sku: form.sku.trim(),
    price: Number(form.price),
    compareAtPrice: form.compareAtPrice.trim() === '' ? null : Number(form.compareAtPrice),
    currency: 'INR' as const,
    shortDescription: form.shortDescription.trim(),
    description: form.description.trim(),
    tags: form.tags
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean),
    rating: Number(form.rating || 0),
    reviewCount: Number(form.reviewCount || 0),
    isFeatured: form.isFeatured,
    isActive: form.isActive,
    quantity: Number(form.quantity || 0),
    lowStockThreshold: Number(form.lowStockThreshold || 5),
    specs: form.specs
      .filter((spec) => spec.key.trim() && spec.value.trim())
      .map((spec) => {
        const trimmed = spec.value.trim();
        // Keep numbers as numbers so specs stay machine-comparable.
        const numeric = Number(trimmed);
        const isNumber = trimmed !== '' && Number.isFinite(numeric) && /^-?\d+(\.\d+)?$/.test(trimmed);
        return {
          key: spec.key.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''),
          label: spec.label.trim() || spec.key.trim(),
          value: isNumber ? numeric : trimmed,
          unit: spec.unit.trim(),
        };
      }),
  });

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setFieldErrors({});

    try {
      const response = await fetch(
        mode === 'create' ? '/api/merchant/products' : `/api/merchant/products/${form.id}`,
        {
          method: mode === 'create' ? 'POST' : 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildPayload()),
        },
      );

      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        const details = payload?.error?.details;
        if (Array.isArray(details)) {
          const next: Record<string, string> = {};
          for (const issue of details) {
            next[String(issue.path).split('.').pop() ?? ''] = issue.message;
          }
          setFieldErrors(next);
        }
        setError(payload?.error?.message ?? 'Could not save the product.');
        setSaving(false);
        return;
      }

      setSaved(true);
      setSaving(false);

      if (mode === 'create') {
        router.push(`/merchant/products/${payload.product.id}`);
      }
      router.refresh();
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
      setSaving(false);
    }
  };

  const deactivate = async () => {
    if (!form.id) return;
    setSaving(true);
    await fetch(`/api/merchant/products/${form.id}`, { method: 'DELETE' });
    setForm((current) => ({ ...current, isActive: false }));
    setSaving(false);
    router.refresh();
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
      {saved && mode === 'edit' ? (
        <InlineAlert tone="success">Saved. The storefront is already showing this.</InlineAlert>
      ) : null}

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[1fr_340px]">
        <div className="flex flex-col gap-4">
          <Card title="Basics">
            <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
              <Field
                className="sm:col-span-2"
                label="Product name"
                value={form.name}
                onChange={set('name')}
                error={fieldErrors.name}
                required
              />
              <Field
                label="Brand"
                value={form.brand}
                onChange={set('brand')}
                error={fieldErrors.brand}
                required
              />
              <Field
                label="SKU"
                value={form.sku}
                onChange={set('sku')}
                error={fieldErrors.sku}
                placeholder="SQ-LAP-0001"
                required
              />

              <label className="flex flex-col gap-2 sm:col-span-2">
                <span className="text-[12.5px] text-[#7E7E88]">Category</span>
                <select
                  value={form.categoryId}
                  onChange={(event) => set('categoryId')(event.target.value)}
                  required
                  className={cx(
                    'h-11 rounded-[10px] border bg-[#0C0C0E] px-3.5 text-[14.5px] text-[#EDEDF0] outline-none transition-colors',
                    fieldErrors.categoryId
                      ? 'border-[rgba(255,107,107,.55)]'
                      : 'border-white/10 focus:border-[rgba(247,147,30,.5)]',
                  )}
                >
                  <option value="">Choose a category…</option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id} className="bg-[#0C0C0E]">
                      {category.name}
                    </option>
                  ))}
                </select>
                {fieldErrors.categoryId ? (
                  <span className="text-[12px] text-[#FF8B8B]">{fieldErrors.categoryId}</span>
                ) : null}
              </label>

              <Field
                className="sm:col-span-2"
                label="Short description"
                value={form.shortDescription}
                onChange={set('shortDescription')}
                error={fieldErrors.shortDescription}
                placeholder="One line that sells it."
              />

              <label className="flex flex-col gap-2 sm:col-span-2">
                <span className="text-[12.5px] text-[#7E7E88]">Full description</span>
                <textarea
                  value={form.description}
                  onChange={(event) => set('description')(event.target.value)}
                  rows={5}
                  className="w-full resize-y rounded-[10px] border border-white/10 bg-[#0C0C0E] px-3.5 py-3 text-[14.5px] leading-relaxed text-[#EDEDF0] outline-none transition-colors focus:border-[rgba(247,147,30,.5)]"
                />
              </label>

              <Field
                className="sm:col-span-2"
                label="Tags (comma separated)"
                value={form.tags}
                onChange={set('tags')}
                placeholder="gaming, rtx 4060, 144hz"
              />
            </div>
          </Card>

          <Card
            title="Specifications"
            action={
              <button
                type="button"
                onClick={addSpec}
                className="inline-flex items-center gap-1.5 rounded-[8px] border border-white/12 px-3 py-1.5 text-[12.5px] text-[#C6C6CC] transition-colors hover:border-white/28 hover:text-white"
              >
                <PlusIcon size={12} /> Add spec
              </button>
            }
          >
            {form.specs.length === 0 ? (
              <p className="m-0 text-[13.5px] leading-relaxed text-[#7E7E88]">
                No specifications yet. Add them as key–value pairs — numeric values are stored as
                numbers so they can be filtered and compared.
              </p>
            ) : (
              <div className="flex flex-col gap-2.5">
                <div className="hidden grid-cols-[1.1fr_1.1fr_1.3fr_0.6fr_32px] gap-2 px-1 text-[11px] uppercase tracking-[0.08em] text-[#6E6E76] sm:grid">
                  <span>Key</span>
                  <span>Label</span>
                  <span>Value</span>
                  <span>Unit</span>
                  <span />
                </div>
                {form.specs.map((spec, index) => (
                  <div
                    key={index}
                    className="grid grid-cols-1 gap-2 sm:grid-cols-[1.1fr_1.1fr_1.3fr_0.6fr_32px] sm:items-center"
                  >
                    <SpecInput
                      value={spec.key}
                      onChange={(value) => updateSpec(index, { key: value })}
                      placeholder="ram_gb"
                      mono
                    />
                    <SpecInput
                      value={spec.label}
                      onChange={(value) => updateSpec(index, { label: value })}
                      placeholder="Memory"
                    />
                    <SpecInput
                      value={spec.value}
                      onChange={(value) => updateSpec(index, { value })}
                      placeholder="32"
                    />
                    <SpecInput
                      value={spec.unit}
                      onChange={(value) => updateSpec(index, { unit: value })}
                      placeholder="GB"
                    />
                    <button
                      type="button"
                      onClick={() => removeSpec(index)}
                      aria-label="Remove specification"
                      className="grid h-8 w-8 place-items-center justify-self-end rounded-[8px] text-[#6E6E76] transition-colors hover:text-[#FF6B6B]"
                    >
                      <CloseIcon size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {mode === 'edit' && form.id ? (
            <ImageManager productId={form.id} images={images} />
          ) : (
            <Card title="Images">
              <p className="m-0 text-[13.5px] leading-relaxed text-[#7E7E88]">
                Save the product first, then upload images. They go straight to Cloudflare R2 —
                only the object key and public URL are stored in the database.
              </p>
            </Card>
          )}
        </div>

        <div className="flex flex-col gap-4 xl:sticky xl:top-6">
          <Card title="Pricing">
            <div className="grid grid-cols-2 gap-3.5">
              <Field
                label="Price (₹)"
                value={form.price}
                onChange={set('price')}
                error={fieldErrors.price}
                inputMode="decimal"
                required
              />
              <Field
                label="Compare at (₹)"
                value={form.compareAtPrice}
                onChange={set('compareAtPrice')}
                error={fieldErrors.compareAtPrice}
                inputMode="decimal"
                placeholder="Optional"
              />
            </div>
            <p className="mb-0 mt-3 text-[12px] leading-relaxed text-[#6E6E76]">
              Compare-at must be at least the selling price. Discounts are derived from the gap.
            </p>
          </Card>

          <Card title="Inventory">
            <div className="grid grid-cols-2 gap-3.5">
              <Field
                label="Quantity"
                value={form.quantity}
                onChange={set('quantity')}
                error={fieldErrors.quantity}
                inputMode="numeric"
              />
              <Field
                label="Low stock at"
                value={form.lowStockThreshold}
                onChange={set('lowStockThreshold')}
                inputMode="numeric"
              />
            </div>
            <p className="mb-0 mt-3 text-[12px] leading-relaxed text-[#6E6E76]">
              Stock reserved against open orders cannot be removed here.
            </p>
          </Card>

          <Card title="Visibility">
            <div className="flex flex-col gap-3">
              <Toggle
                checked={form.isActive}
                onChange={set('isActive')}
                label="Active"
                hint="Visible on the storefront"
              />
              <Toggle
                checked={form.isFeatured}
                onChange={set('isFeatured')}
                label="Featured"
                hint="Shown on the homepage rail"
              />
            </div>
          </Card>

          <Card title="Social proof">
            <div className="grid grid-cols-2 gap-3.5">
              <Field
                label="Rating (0–5)"
                value={form.rating}
                onChange={set('rating')}
                error={fieldErrors.rating}
                inputMode="decimal"
              />
              <Field
                label="Review count"
                value={form.reviewCount}
                onChange={set('reviewCount')}
                inputMode="numeric"
              />
            </div>
          </Card>

          <div className="flex flex-col gap-2.5">
            <Button type="submit" variant="primary" size="lg" fullWidth loading={saving}>
              {mode === 'create' ? 'Create product' : 'Save changes'}
            </Button>
            {mode === 'edit' && form.isActive ? (
              <Button type="button" variant="danger" onClick={deactivate} disabled={saving}>
                Deactivate product
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ images */

function ImageManager({
  productId,
  images: initialImages,
}: {
  productId: string;
  images: ExistingImage[];
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [images, setImages] = useState(initialImages);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const upload = async (file: File) => {
    setUploading(true);
    setUploadError(null);

    const body = new FormData();
    body.append('file', file);
    body.append('isPrimary', images.length === 0 ? 'true' : 'false');

    try {
      const response = await fetch(`/api/merchant/products/${productId}/images`, {
        method: 'POST',
        body,
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        setUploadError(payload?.error?.message ?? 'Upload failed.');
      } else {
        setImages((current) => [...current, payload.image as ExistingImage]);
        router.refresh();
      }
    } catch {
      setUploadError('Could not reach the server.');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const remove = async (imageId: string) => {
    setUploadError(null);
    const response = await fetch(
      `/api/merchant/products/${productId}/images?imageId=${imageId}`,
      { method: 'DELETE' },
    );
    if (response.ok) {
      setImages((current) => current.filter((image) => image.id !== imageId));
      router.refresh();
    } else {
      setUploadError('Could not remove that image.');
    }
  };

  return (
    <Card title="Images">
      {uploadError ? (
        <div className="mb-3.5">
          <InlineAlert tone="error">{uploadError}</InlineAlert>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {images.map((image) => (
          <div
            key={image.id}
            className="group relative aspect-square overflow-hidden rounded-[12px] border border-white/8 bg-[#121216]"
          >
            <Image
              src={image.public_url}
              alt={image.alt_text ?? ''}
              fill
              sizes="160px"
              className="object-cover"
            />
            {image.is_primary ? (
              <span className="absolute left-2 top-2 rounded-[6px] brand-gradient px-1.5 py-0.5 text-[10px] font-semibold text-[#1A0D02]">
                Primary
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => remove(image.id)}
              aria-label="Remove image"
              className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-[8px] border border-white/12 bg-black/70 text-[#C6C6CC] opacity-0 transition-opacity hover:text-[#FF6B6B] group-hover:opacity-100"
            >
              <CloseIcon size={13} />
            </button>
          </div>
        ))}

        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="grid aspect-square place-items-center rounded-[12px] border border-dashed border-white/14 text-[#7E7E88] transition-colors hover:border-[rgba(247,147,30,.5)] hover:text-[#FFC07A] disabled:opacity-50"
        >
          <span className="flex flex-col items-center gap-2 px-2 text-center">
            <UploadIcon size={18} />
            <span className="text-[12px]">{uploading ? 'Uploading…' : 'Upload image'}</span>
          </span>
        </button>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/webp,image/png,image/jpeg,image/avif,image/svg+xml"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
        }}
      />

      <p className="mb-0 mt-3.5 text-[12px] leading-relaxed text-[#6E6E76]">
        WebP, PNG, JPEG, AVIF or SVG, up to 5 MB. Files are validated by content, not by
        extension, and stored in Cloudflare R2 under products/{productId}/.
      </p>
    </Card>
  );
}

/* -------------------------------------------------------------- form parts */

function Card({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="rounded-[16px] border border-white/8 bg-[#08080A] p-5 md:p-6">
      <div className="mb-4.5 flex items-center justify-between gap-3">
        <h2 className="m-0 text-[16px] font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  error,
  className,
  ...rest
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  className?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'className'>) {
  return (
    <label className={cx('flex flex-col gap-2', className)}>
      <span className="text-[12.5px] text-[#7E7E88]">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={Boolean(error)}
        className={cx(
          'h-11 rounded-[10px] border bg-[#0C0C0E] px-3.5 text-[14.5px] text-[#EDEDF0] outline-none transition-colors',
          error
            ? 'border-[rgba(255,107,107,.55)]'
            : 'border-white/10 focus:border-[rgba(247,147,30,.5)]',
        )}
        {...rest}
      />
      {error ? <span className="text-[12px] text-[#FF8B8B]">{error}</span> : null}
    </label>
  );
}

function SpecInput({
  value,
  onChange,
  placeholder,
  mono,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <input
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      className={cx(
        'h-10 rounded-[9px] border border-white/10 bg-[#0C0C0E] px-3 text-[13.5px] text-[#EDEDF0] outline-none transition-colors focus:border-[rgba(247,147,30,.5)]',
        mono && 'font-mono text-[13px]',
      )}
    />
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="sr-only"
      />
      <span
        className={cx(
          'mt-0.5 grid h-[18px] w-[18px] shrink-0 place-items-center rounded-[5px] transition-colors',
          checked ? 'brand-gradient text-[#1A0D02]' : 'border border-white/20',
        )}
      >
        {checked ? <CheckIcon size={11} /> : null}
      </span>
      <span className="min-w-0">
        <span className="block text-[14px] text-[#EDEDF0]">{label}</span>
        {hint ? <span className="mt-1 block text-[12px] text-[#6E6E76]">{hint}</span> : null}
      </span>
    </label>
  );
}
