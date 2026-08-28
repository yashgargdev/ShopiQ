import coreWebVitals from 'eslint-config-next/core-web-vitals';
import typescriptConfig from 'eslint-config-next/typescript';

/**
 * ShopiQ lint configuration.
 *
 * eslint-config-next 16 ships native flat configs, so they are spread directly
 * rather than bridged through FlatCompat — the bridge cannot serialise the
 * React plugin's circular structure and fails before linting anything.
 *
 * The test and seed scripts are excluded: they are plain Node ESM, and linting
 * them against React and Next rules produces noise rather than signal.
 */
const config = [
  ...coreWebVitals,
  ...typescriptConfig,
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'scripts/**',
      'eval/**',
      'supabase/**',
      'next-env.d.ts',
    ],
  },
];

export default config;
