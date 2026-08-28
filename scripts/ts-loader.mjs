/**
 * Minimal Node module loader so the AI unit tests can import the real
 * TypeScript sources directly — no build step, no test framework.
 *
 * It does two things Node cannot do on its own:
 *   1. resolves the `@/…` path alias from tsconfig
 *   2. stubs `server-only`, which throws outside a Next.js build
 *
 * Type stripping itself is native in modern Node, so there is no transpiler
 * here. Registered by the test scripts via `register()`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const EXTENSIONS = ['', '.ts', '.tsx', '.mjs', '.js', '/index.ts', '/index.tsx', '/index.js'];

function firstExisting(basePath) {
  for (const extension of EXTENSIONS) {
    const candidate = basePath + extension;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  // `server-only` is a build-time guard; in tests it is a no-op.
  if (specifier === 'server-only' || specifier === 'client-only') {
    return {
      url: pathToFileURL(path.join(ROOT, 'scripts/stubs/empty.mjs')).href,
      shortCircuit: true,
    };
  }

  // `next/headers` only exists inside a Next request; the stub supplies an
  // empty cookie store so Supabase clients fall back to the anonymous role.
  if (specifier === 'next/headers') {
    return {
      url: pathToFileURL(path.join(ROOT, 'scripts/stubs/next-headers.mjs')).href,
      shortCircuit: true,
    };
  }

  // Next ships these as extensioned files; the framework's own bundler adds
  // the extension, plain Node does not.
  if (specifier === 'next/server' || specifier === 'next/navigation') {
    return nextResolve(`${specifier}.js`, context);
  }

  // tsconfig path alias: "@/*" -> "./*"
  if (specifier.startsWith('@/')) {
    const resolved = firstExisting(path.join(ROOT, specifier.slice(2)));
    if (resolved) {
      return { url: pathToFileURL(resolved).href, shortCircuit: true };
    }
  }

  // Extensionless relative imports, which TypeScript allows and Node does not.
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const parentPath = context.parentURL?.startsWith('file:')
      ? path.dirname(new URL(context.parentURL).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
      : ROOT;
    const resolved = firstExisting(path.resolve(parentPath, specifier));
    if (resolved) {
      return { url: pathToFileURL(resolved).href, shortCircuit: true };
    }
  }

  return nextResolve(specifier, context);
}
