import type { Metadata, Viewport } from 'next';

import './globals.css';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://shopiq.yashgarg.co.in';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'ShopiQ — Shop smarter',
    template: '%s · ShopiQ',
  },
  description:
    'ShopiQ is an AI-native commerce platform. Discover products, compare options, and find what fits your needs — all from one intelligent shopping experience.',
  applicationName: 'ShopiQ',
  // Icons, the manifest and the social image are picked up automatically from
  // app/icon.png, app/apple-icon.png, app/favicon.ico, app/manifest.ts and
  // app/opengraph-image.png — declaring them here as well would emit the tags
  // twice.
  authors: [{ name: 'Yash Garg' }],
  creator: 'Yash Garg',
  keywords: [
    'AI shopping assistant',
    'voice shopping',
    'conversational commerce',
    'ShopiQ',
  ],
  openGraph: {
    type: 'website',
    siteName: 'ShopiQ',
    title: 'ShopiQ — Shop smarter',
    description:
      'An AI shopping assistant you can talk to. Find products, compare options and check out by voice or chat, in English or Hindi.',
    locale: 'en_IN',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'ShopiQ — Shop smarter',
    description:
      'An AI shopping assistant you can talk to, in English or Hindi.',
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: '#000000',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
};

/**
 * The document shell only.
 *
 * Chrome lives one level down, because the two halves of ShopiQ need different
 * frames: `(storefront)` gets the header, footer, cart provider and AI panel;
 * `merchant` gets its own rail. Putting any of that here would stack the
 * shopper's header on top of the merchant panel.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700&family=Geist+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="bg-black text-white antialiased">{children}</body>
    </html>
  );
}
