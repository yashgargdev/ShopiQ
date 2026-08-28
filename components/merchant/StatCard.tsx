import type { ReactNode } from 'react';

import { cx } from '@/lib/format';

/** The tiles used across the merchant overview and analytics screens. */
export function StatCard({
  label,
  value,
  hint,
  tone = 'default',
  icon,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'default' | 'warn' | 'danger' | 'ok';
  icon?: ReactNode;
}) {
  const accent = {
    default: 'text-[#EDEDF0]',
    ok: 'text-[#4ED17E]',
    warn: 'text-[#FFB65C]',
    danger: 'text-[#FF8B8B]',
  }[tone];

  return (
    <div className="rounded-[16px] border border-white/8 bg-[#08080A] p-5">
      <div className="flex items-center gap-2 text-[12.5px] text-[#7E7E88]">
        {icon}
        {label}
      </div>
      <div className={cx('mt-3 text-[26px] font-semibold leading-none tracking-[-0.02em]', accent)}>
        {value}
      </div>
      {hint ? <div className="mt-2.5 text-[12.5px] text-[#6E6E76]">{hint}</div> : null}
    </div>
  );
}
