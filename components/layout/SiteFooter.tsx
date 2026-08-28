import Link from 'next/link';

import { ShopiQMark } from './SiteHeader';

const COLUMNS = [
  {
    title: 'Shop',
    links: [
      { href: '/categories/laptops', label: 'Laptops' },
      { href: '/categories/smartphones', label: 'Smartphones' },
      { href: '/categories/gaming-laptops', label: 'Gaming' },
      { href: '/products?sort=discount', label: 'Deals' },
    ],
  },
  {
    title: 'Company',
    links: [
      { href: '/products', label: 'Catalogue' },
      { href: '/categories', label: 'Categories' },
      { href: '/merchant', label: 'Merchant panel' },
    ],
  },
  {
    title: 'Support',
    links: [
      { href: '/orders', label: 'Track order' },
      { href: '/account', label: 'Your account' },
      { href: '/cart', label: 'Your cart' },
    ],
  },
];

export function SiteFooter() {
  const email = process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? 'shopiq@yashgarg.co.in';

  return (
    <footer className="border-t border-white/7 px-5 pb-14 pt-13 md:px-8">
      <div className="mx-auto grid max-w-[1320px] grid-cols-1 gap-10 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
        <div>
          <div className="flex items-center gap-2.5">
            <ShopiQMark size={26} />
            <span className="brand-text text-[17px] font-semibold leading-none">ShopiQ</span>
          </div>
          <p className="mt-4 mb-0 max-w-[280px] text-[13.5px] leading-[1.7] text-[#6E6E76]">
            AI-native commerce for laptops, phones, gaming gear and the accessories that go with
            them.
          </p>
          <div className="mt-4 text-[13.5px] leading-[1.7] text-[#6E6E76]">
            shopiq.yashgarg.co.in
            <br />
            <a href={`mailto:${email}`} className="text-[#F7931E] hover:text-[#FFB65C]">
              {email}
            </a>
          </div>
        </div>

        {COLUMNS.map((column) => (
          <div key={column.title}>
            <div className="mb-4 text-[13px] font-medium leading-none">{column.title}</div>
            <div className="flex flex-col gap-2.5 text-[13.5px]">
              {column.links.map((link) => (
                <Link
                  key={link.href + link.label}
                  href={link.href}
                  className="text-[#7E7E88] transition-colors hover:text-white"
                >
                  {link.label}
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="mx-auto mt-11 max-w-[1320px] border-t border-white/6 pt-5.5 text-[12.5px] text-[#4E4E56]">
        © {new Date().getFullYear()} ShopiQ · AI commerce agent · Razorpay test mode
      </div>
    </footer>
  );
}
