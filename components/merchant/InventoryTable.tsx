'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { CheckIcon } from '@/components/ui/icons';
import { InlineAlert } from '@/components/ui/primitives';
import { cx, formatDate } from '@/lib/format';
import type { InventoryRow } from '@/types';

/**
 * Inventory grid with inline stock editing.
 *
 * Available = quantity − reserved, computed in Postgres as a stored generated
 * column. The server refuses any quantity below what is already reserved
 * against open orders, so available can never go negative.
 */

const STATUS_LABEL = {
  healthy: { label: 'Healthy', className: 'bg-[rgba(78,209,126,.14)] text-[#4ED17E]' },
  low_stock: { label: 'Low Stock', className: 'bg-[rgba(247,147,30,.16)] text-[#FFB65C]' },
  out_of_stock: { label: 'Out of Stock', className: 'bg-[rgba(255,107,107,.14)] text-[#FF8B8B]' },
} as const;

export function InventoryTable({ rows }: { rows: InventoryRow[] }) {
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      {error ? (
        <div className="mb-4">
          <InlineAlert tone="error">{error}</InlineAlert>
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-[16px] border border-white/8">
        <table className="w-full min-w-[860px] border-collapse text-left">
          <thead>
            <tr className="border-b border-white/8 bg-[#0A0A0C]">
              <Th>Product</Th>
              <Th>SKU</Th>
              <Th className="text-right">Stock</Th>
              <Th className="text-right">Reserved</Th>
              <Th className="text-right">Available</Th>
              <Th>Status</Th>
              <Th className="text-right">Updated</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <InventoryRowView key={row.productId} row={row} onError={setError} />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function InventoryRowView({
  row,
  onError,
}: {
  row: InventoryRow;
  onError: (message: string | null) => void;
}) {
  const router = useRouter();
  const [quantity, setQuantity] = useState(String(row.quantity));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const dirty = quantity !== String(row.quantity);

  const save = async () => {
    const next = Number(quantity);
    if (!Number.isInteger(next) || next < 0) {
      onError('Stock must be a whole number of units.');
      setQuantity(String(row.quantity));
      return;
    }
    if (next === row.quantity) return;

    setSaving(true);
    onError(null);

    try {
      const response = await fetch('/api/merchant/inventory', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: row.productId, quantity: next }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        onError(payload?.error?.message ?? 'Could not update stock.');
        setQuantity(String(row.quantity));
      } else {
        setSaved(true);
        setTimeout(() => setSaved(false), 1600);
        router.refresh();
      }
    } catch {
      onError('Could not reach the server.');
      setQuantity(String(row.quantity));
    } finally {
      setSaving(false);
    }
  };

  const status = STATUS_LABEL[row.status];
  // Optimistic preview while the field is dirty.
  const previewAvailable = dirty
    ? Math.max((Number(quantity) || 0) - row.reservedQuantity, 0)
    : row.available;

  return (
    <tr
      className={cx(
        'border-b border-white/6 transition-colors last:border-b-0 hover:bg-[#0A0A0C]',
        saving && 'opacity-60',
      )}
    >
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-[8px] bg-[#121216]">
            {row.image ? (
              <Image src={row.image} alt="" fill sizes="40px" className="object-cover" />
            ) : null}
          </div>
          <div className="min-w-0">
            <Link
              href={`/merchant/products/${row.productId}`}
              className="block truncate text-[14px] font-medium text-white hover:text-[#FFC07A]"
            >
              {row.name}
            </Link>
            <div className="mt-1 text-[11.5px] text-[#6E6E76]">
              {row.brand}
              {!row.isActive ? ' · inactive' : ''}
            </div>
          </div>
        </div>
      </td>

      <td className="px-4 py-3 font-mono text-[12.5px] text-[#9A9AA2]">{row.sku}</td>

      <td className="px-4 py-3 text-right">
        <div className="flex items-center justify-end gap-2">
          <input
            value={quantity}
            inputMode="numeric"
            onChange={(event) => setQuantity(event.target.value.replace(/\D/g, ''))}
            onBlur={save}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
              if (event.key === 'Escape') setQuantity(String(row.quantity));
            }}
            aria-label={`Stock quantity for ${row.name}`}
            disabled={saving}
            className={cx(
              'h-9 w-20 rounded-[8px] border bg-[#0C0C0E] px-2.5 text-right font-mono text-[13.5px] text-[#EDEDF0] outline-none transition-colors',
              dirty
                ? 'border-[rgba(247,147,30,.55)]'
                : 'border-white/10 focus:border-[rgba(247,147,30,.5)]',
            )}
          />
          {saved ? <CheckIcon size={13} className="text-[#4ED17E]" /> : null}
        </div>
      </td>

      <td className="px-4 py-3 text-right font-mono text-[13.5px] text-[#9A9AA2]">
        {row.reservedQuantity}
      </td>

      <td className="px-4 py-3 text-right">
        <span
          className={cx(
            'font-mono text-[14px] font-medium',
            previewAvailable <= 0
              ? 'text-[#FF8B8B]'
              : previewAvailable <= row.lowStockThreshold
                ? 'text-[#FFB65C]'
                : 'text-[#EDEDF0]',
          )}
        >
          {previewAvailable}
        </span>
      </td>

      <td className="px-4 py-3">
        <span
          className={cx(
            'inline-flex items-center rounded-full px-2.5 py-1 text-[11.5px] font-medium',
            status.className,
          )}
        >
          {status.label}
        </span>
      </td>

      <td className="px-4 py-3 text-right text-[12.5px] text-[#6E6E76]">
        {formatDate(row.updatedAt)}
      </td>
    </tr>
  );
}

function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <th
      className={`px-4 py-3 text-[11.5px] font-medium uppercase tracking-[0.08em] text-[#6E6E76] ${className ?? ''}`}
    >
      {children}
    </th>
  );
}
