import { ShopiQMark } from '@/components/layout/SiteHeader';
import { LinkButton } from '@/components/ui/primitives';

/**
 * 404 inside the storefront, so a missing product still renders with the
 * header, footer and a way back into the catalogue.
 */
export default function StorefrontNotFound() {
  return (
    <main className="flex min-h-[70vh] items-center px-5 py-16 md:px-8">
      <div className="mx-auto w-full max-w-[480px] text-center">
        <div className="mb-6 flex justify-center">
          <ShopiQMark size={44} />
        </div>
        <div className="font-mono text-[13px] uppercase tracking-[0.14em] text-[#6E6E76]">404</div>
        <h1 className="mb-0 mt-3 text-[26px] font-semibold leading-tight tracking-[-0.03em]">
          We couldn&apos;t find that page
        </h1>
        <p className="mx-auto mb-0 mt-4 max-w-[400px] text-[15px] leading-relaxed text-[#9A9AA2]">
          The link may be out of date, or the product may no longer be listed.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <LinkButton href="/products" variant="primary">
            Explore Products
          </LinkButton>
          <LinkButton href="/" variant="ghost">
            Back to home
          </LinkButton>
        </div>
      </div>
    </main>
  );
}
