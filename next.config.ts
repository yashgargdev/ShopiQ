import type { NextConfig } from 'next';

/**
 * Every IPv4 address this machine answers on.
 *
 * Next's dev server 403s `/_next/static/*` for an unrecognised Origin, which
 * serves the HTML but none of the JavaScript — the page renders and is
 * completely inert. Enumerating the real interfaces means testing on a phone
 * works without editing this file every time the router hands out a new lease.
 */
function localNetworkHosts(): string[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('node:os') as typeof import('node:os');
    return Object.values(os.networkInterfaces())
      .flat()
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .filter((entry) => entry.family === 'IPv4' && !entry.internal)
      .map((entry) => entry.address);
  } catch {
    return [];
  }
}

const r2Host = (() => {
  const raw = process.env.R2_PUBLIC_URL;
  if (!raw) return null;
  try {
    return new URL(raw.startsWith('http') ? raw : `https://${raw}`).hostname;
  } catch {
    return null;
  }
})();

const nextConfig: NextConfig = {
  reactStrictMode: true,

  /**
   * Origins allowed to load dev-server assets.
   *
   * Next's dev server refuses `/_next/static/*` requests from an origin it
   * does not recognise, answering 403. Opening the app on a phone via the
   * machine's LAN address therefore serves the HTML but none of the
   * JavaScript, and the page renders while being completely inert — no chat,
   * no cart, no checkout. The symptom looks like broken application code and
   * is not.
   *
   * Private ranges only, and dev-only by nature: this key has no effect on a
   * production build.
   */
  allowedDevOrigins: [
    // Hostname patterns, not CIDR ranges — Next matches these as globs
    // against the request's Origin host.
    'localhost',
    '127.0.0.1',
    '192.168.*.*',
    '10.*.*.*',
    '172.16.*.*',
    // The current machine's LAN address, resolved at startup so a changed
    // DHCP lease does not silently break phone testing again.
    ...localNetworkHosts(),
  ],

  images: {
    // Product art is served from the R2 custom domain. SVG is allowed because
    // every object under this host is written by ShopiQ's own upload path,
    // which sniffs file contents before accepting them.
    remotePatterns: r2Host
      ? [{ protocol: 'https', hostname: r2Host, pathname: '/**' }]
      : [],
    dangerouslyAllowSVG: true,
    contentDispositionType: 'attachment',
    contentSecurityPolicy: "default-src 'self'; script-src 'none'; sandbox;",
    formats: ['image/webp'],
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default nextConfig;
