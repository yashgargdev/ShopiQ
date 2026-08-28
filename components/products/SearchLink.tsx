'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { SearchIcon } from '@/components/ui/icons';
import { cx } from '@/lib/format';

/**
 * The inline search field on the catalogue pages. Submits to /search so the
 * query is in the URL and the result page is shareable.
 */
export function SearchLink({
  className,
  defaultValue = '',
  placeholder = 'Search products…',
  autoFocus = false,
}: {
  className?: string;
  defaultValue?: string;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const router = useRouter();
  const [value, setValue] = useState(defaultValue);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = value.trim();
        router.push(trimmed ? `/search?q=${encodeURIComponent(trimmed)}` : '/products');
      }}
      className={cx(
        'flex h-12 items-center gap-2.5 rounded-[12px] border border-white/9 bg-[#0A0A0C] px-4 transition-colors focus-within:border-[rgba(247,147,30,.45)]',
        className,
      )}
      role="search"
    >
      <SearchIcon size={16} className="shrink-0 text-[#8B8B92]" />
      <input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={placeholder}
        aria-label="Search products"
        autoFocus={autoFocus}
        className="min-w-0 flex-1 border-none bg-transparent text-[14.5px] text-white outline-none placeholder:text-[#8B8B92]"
      />
      {value ? (
        <button
          type="submit"
          className="shrink-0 rounded-[8px] brand-gradient px-3 py-1.5 text-[12.5px] font-semibold text-[#1A0D02]"
        >
          Search
        </button>
      ) : null}
    </form>
  );
}
