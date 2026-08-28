/**
 * Stub for `next/headers` so server modules can be imported by the test
 * runner outside a Next.js request. Returns an empty, in-memory cookie store,
 * which makes Supabase clients resolve to the anonymous role — exactly the
 * privileges an unauthenticated shopper has.
 */
const store = new Map();

export async function cookies() {
  return {
    getAll: () => [...store.entries()].map(([name, value]) => ({ name, value })),
    get: (name) => (store.has(name) ? { name, value: store.get(name) } : undefined),
    set: (name, value) => { store.set(name, value); },
    delete: (name) => { store.delete(name); },
  };
}

export async function headers() {
  return new Headers();
}

export async function draftMode() {
  return { isEnabled: false, enable() {}, disable() {} };
}
