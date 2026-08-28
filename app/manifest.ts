import type { MetadataRoute } from 'next';

/**
 * Web app manifest.
 *
 * ShopiQ is a voice-first shopping assistant, so being installable matters
 * more than it would for an ordinary storefront: `getUserMedia` requires a
 * secure context, and an installed app gets one without the address bar
 * competing for the screen on a phone.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'ShopiQ — Shop smarter',
    short_name: 'ShopiQ',
    description:
      'An AI shopping assistant you can talk to. Find products, compare options and check out by voice or chat, in English or Hindi.',
    start_url: '/',
    display: 'standalone',
    background_color: '#000000',
    theme_color: '#000000',
    orientation: 'portrait',
    categories: ['shopping', 'productivity'],
    icons: [
      { src: '/icon.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/apple-icon.png', sizes: '180x180', type: 'image/png' },
    ],
  };
}
