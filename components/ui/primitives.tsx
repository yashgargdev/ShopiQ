import Link from 'next/link';
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';

import { cx, discountPercent, formatNumber, formatPrice } from '@/lib/format';
import { AlertIcon, SparkIcon, SpinnerIcon, StarIcon } from './icons';

/* ==========================================================================
   Buttons — the four treatments the design uses, and nothing more.
   ========================================================================== */

type Variant = 'primary' | 'secondary' | 'ghost' | 'ai' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const VARIANT: Record<Variant, string> = {
  primary:
    'brand-gradient text-[#1A0D02] border border-transparent shadow-[0_8px_30px_-14px_rgba(247,147,30,.7)] hover:brightness-107',
  secondary:
    'bg-[#141418] text-white border border-white/12 hover:border-white/32',
  ghost:
    'bg-transparent text-[#E6E6EA] border border-white/14 hover:border-white/30 hover:text-white',
  ai: 'bg-[rgba(247,147,30,.1)] text-[#FFC07A] border border-[rgba(247,147,30,.42)] hover:bg-[rgba(247,147,30,.18)] hover:border-[rgba(247,147,30,.7)]',
  danger:
    'bg-transparent text-[#FF8B8B] border border-[rgba(255,107,107,.3)] hover:border-[rgba(255,107,107,.6)] hover:bg-[rgba(255,107,107,.08)]',
};

const SIZE: Record<Size, string> = {
  sm: 'h-9 px-3.5 text-[13px] rounded-[9px]',
  md: 'h-[38px] px-4 text-[13.5px] rounded-[10px]',
  lg: 'h-[50px] px-6 text-[15px] rounded-[12px]',
};

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-2 font-medium whitespace-nowrap transition-[background,border-color,color,filter,transform] duration-200 disabled:opacity-50 disabled:pointer-events-none';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  fullWidth?: boolean;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  fullWidth = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={cx(
        BUTTON_BASE,
        VARIANT[variant],
        SIZE[size],
        fullWidth && 'w-full',
        variant === 'primary' && 'font-semibold',
        className,
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <SpinnerIcon size={15} /> : null}
      {children}
    </button>
  );
}

interface LinkButtonProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  variant?: Variant;
  size?: Size;
  fullWidth?: boolean;
}

export function LinkButton({
  href,
  variant = 'secondary',
  size = 'md',
  fullWidth = false,
  className,
  children,
  ...rest
}: LinkButtonProps) {
  return (
    <Link
      href={href}
      className={cx(
        BUTTON_BASE,
        VARIANT[variant],
        SIZE[size],
        fullWidth && 'w-full',
        variant === 'primary' && 'font-semibold',
        className,
      )}
      {...rest}
    >
      {children}
    </Link>
  );
}

/* ==========================================================================
   Price and rating
   ========================================================================== */

export function Price({
  amount,
  compareAt,
  currency = 'INR',
  size = 'md',
  className,
}: {
  amount: number;
  compareAt?: number | null;
  currency?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}) {
  const off = discountPercent(amount, compareAt);
  const sizes = {
    sm: ['text-[14px]', 'text-[12px]'],
    md: ['text-[17px]', 'text-[13px]'],
    lg: ['text-[22px]', 'text-[15px]'],
    xl: ['text-[34px]', 'text-[17px]'],
  }[size];

  return (
    <div className={cx('flex items-baseline gap-2.5', className)}>
      <span className={cx('font-semibold tracking-[-0.01em] text-white', sizes[0])}>
        {formatPrice(amount, currency)}
      </span>
      {off !== null && compareAt ? (
        <span className={cx('text-[#6E6E76] line-through font-normal', sizes[1])}>
          {formatPrice(compareAt, currency)}
        </span>
      ) : null}
      {off !== null && size === 'xl' ? (
        <span className="rounded-lg bg-[rgba(247,147,30,.14)] px-2.5 py-[5px] text-[12.5px] font-semibold text-[#FFB65C]">
          {off}% off
        </span>
      ) : null}
    </div>
  );
}

export function Rating({
  value,
  count,
  size = 13,
  className,
}: {
  value: number;
  count?: number;
  size?: number;
  className?: string;
}) {
  if (!value) {
    return <span className={cx('text-[12.5px] text-[#6E6E76]', className)}>No ratings yet</span>;
  }
  return (
    <div className={cx('flex items-center gap-1.5 text-[12.5px] text-[#9A9AA2]', className)}>
      <StarIcon size={size} className="text-[#F7931E]" />
      <span className="font-medium text-[#EDEDF0]">{value.toFixed(1)}</span>
      {count !== undefined ? <span>({formatNumber(count)})</span> : null}
    </div>
  );
}

/* ==========================================================================
   Badges and stock indicators
   ========================================================================== */

export function DiscountBadge({ percent }: { percent: number }) {
  return (
    <span className="pointer-events-none absolute left-2.5 top-2.5 rounded-[7px] brand-gradient px-2 py-1 text-[11px] font-semibold leading-none text-[#1A0D02]">
      {percent}% off
    </span>
  );
}

const STOCK_TONE = {
  in: 'text-[#4ED17E]',
  low: 'text-[#FFB65C]',
  out: 'text-[#FF8B8B]',
} as const;

export function StockPill({
  available,
  inStock,
  lowStock,
  showCount = false,
  className,
}: {
  available: number;
  inStock: boolean;
  lowStock: boolean;
  showCount?: boolean;
  className?: string;
}) {
  const tone = !inStock ? 'out' : lowStock ? 'low' : 'in';
  const label = !inStock
    ? 'Out of stock'
    : lowStock
      ? `Only ${available} left`
      : showCount
        ? `In stock · ${available} available`
        : 'In stock · ships in 24 hours';

  return (
    <span className={cx('flex items-center gap-2 text-[14px]', STOCK_TONE[tone], className)}>
      <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-current" />
      {label}
    </span>
  );
}

export function StatusPill({ status }: { status: string }) {
  const tone =
    {
      delivered: 'bg-[rgba(78,209,126,.14)] text-[#4ED17E]',
      shipped: 'bg-[rgba(247,147,30,.16)] text-[#FFB65C]',
      confirmed: 'bg-[rgba(247,147,30,.12)] text-[#FFC07A]',
      processing: 'bg-white/9 text-[#C6C6CC]',
      pending: 'bg-white/9 text-[#C6C6CC]',
      cancelled: 'bg-[rgba(255,107,107,.14)] text-[#FF8B8B]',
      refunded: 'bg-[rgba(255,107,107,.1)] text-[#FF8B8B]',
      paid: 'bg-[rgba(78,209,126,.14)] text-[#4ED17E]',
      unpaid: 'bg-white/9 text-[#9A9AA2]',
      failed: 'bg-[rgba(255,107,107,.14)] text-[#FF8B8B]',
    }[status.toLowerCase()] ?? 'bg-white/9 text-[#C6C6CC]';

  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full px-2.5 py-[5px] text-[12px] font-medium capitalize leading-none',
        tone,
      )}
    >
      {status}
    </span>
  );
}

/* ==========================================================================
   Section furniture
   ========================================================================== */

export function SectionHeading({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h2 className="m-0 text-[24px] font-semibold leading-none tracking-[-0.02em]">{title}</h2>
        {subtitle ? <p className="mt-2.5 mb-0 text-[14px] text-[#7E7E88]">{subtitle}</p> : null}
      </div>
      {action}
    </div>
  );
}

/* ==========================================================================
   Empty / error / loading states — every list surface uses these rather than
   rendering a blank area.
   ========================================================================== */

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-[18px] border border-dashed border-white/10 bg-[#08080A] px-8 py-16 text-center">
      <div className="mb-4 grid h-12 w-12 place-items-center rounded-[14px] border border-white/8 bg-[#0F0F12] text-[#7E7E88]">
        {icon ?? <SparkIcon size={18} />}
      </div>
      <h3 className="m-0 text-[17px] font-medium text-[#EDEDF0]">{title}</h3>
      {description ? (
        <p className="mx-auto mt-2.5 mb-0 max-w-[420px] text-[14px] leading-relaxed text-[#7E7E88]">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-6">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  title = 'Something went wrong',
  description,
  action,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-[18px] border border-[rgba(255,107,107,.25)] bg-[rgba(255,107,107,.04)] px-8 py-14 text-center">
      <div className="mb-4 grid h-12 w-12 place-items-center rounded-[14px] border border-[rgba(255,107,107,.25)] bg-[rgba(255,107,107,.06)] text-[#FF8B8B]">
        <AlertIcon size={20} />
      </div>
      <h3 className="m-0 text-[17px] font-medium text-[#EDEDF0]">{title}</h3>
      {description ? (
        <p className="mx-auto mt-2.5 mb-0 max-w-[440px] text-[14px] leading-relaxed text-[#9A9AA2]">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-6">{action}</div> : null}
    </div>
  );
}

export function InlineAlert({
  tone = 'warn',
  children,
}: {
  tone?: 'warn' | 'error' | 'success' | 'info';
  children: ReactNode;
}) {
  const styles = {
    warn: 'border-[rgba(247,147,30,.3)] bg-[rgba(247,147,30,.07)] text-[#FFC07A]',
    error: 'border-[rgba(255,107,107,.3)] bg-[rgba(255,107,107,.06)] text-[#FF8B8B]',
    success: 'border-[rgba(78,209,126,.3)] bg-[rgba(78,209,126,.06)] text-[#4ED17E]',
    info: 'border-white/12 bg-white/3 text-[#C6C6CC]',
  }[tone];

  return (
    <div
      className={cx(
        'flex items-start gap-2.5 rounded-[12px] border px-4 py-3 text-[13.5px] leading-relaxed',
        styles,
      )}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      <AlertIcon size={15} className="mt-0.5 shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function CardSkeleton() {
  return (
    <div className="overflow-hidden rounded-[16px] border border-white/7 bg-[#0A0A0C]">
      <div className="skeleton aspect-[4/3] w-full" />
      <div className="flex flex-col gap-2.5 p-4">
        <div className="skeleton h-2.5 w-16 rounded" />
        <div className="skeleton h-4 w-4/5 rounded" />
        <div className="skeleton h-3 w-24 rounded" />
        <div className="skeleton h-5 w-28 rounded" />
        <div className="skeleton mt-2 h-[38px] w-full rounded-[10px]" />
      </div>
    </div>
  );
}

export function GridSkeleton({ count = 8, columns = 4 }: { count?: number; columns?: number }) {
  const cols =
    { 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-2 lg:grid-cols-3', 4: 'sm:grid-cols-2 lg:grid-cols-4' }[
      columns
    ] ?? 'sm:grid-cols-2 lg:grid-cols-4';

  return (
    <div className={cx('grid grid-cols-1 gap-4', cols)}>
      {Array.from({ length: count }, (_, index) => (
        <CardSkeleton key={index} />
      ))}
    </div>
  );
}
