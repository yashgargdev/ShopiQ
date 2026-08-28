'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useTransition,
} from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';

import type { Cart } from '@/types';

/**
 * Client-side cart state.
 *
 * The server is the source of truth: each mutation posts to /api/cart/* and the
 * response — priced and stock-checked server-side — replaces local state. The
 * initial value is server-rendered so the header badge is correct on first
 * paint with no flash.
 */

interface CartState {
  cart: Cart | null;
  itemCount: number;
  pending: boolean;
  error: string | null;
  addItem: (productId: string, quantity?: number) => Promise<boolean>;
  updateItem: (itemId: string, quantity: number) => Promise<void>;
  removeItem: (itemId: string) => Promise<void>;
  clearError: () => void;
  refresh: () => Promise<void>;
}

const CartContext = createContext<CartState | null>(null);

export function CartProvider({
  children,
  initialCart,
  initialCount,
}: {
  children: ReactNode;
  initialCart: Cart | null;
  initialCount: number;
}) {
  const router = useRouter();
  const [cart, setCart] = useState<Cart | null>(initialCart);
  const [count, setCount] = useState(initialCount);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [isPending, startTransition] = useTransition();

  const applyCart = useCallback((next: Cart) => {
    setCart(next);
    setCount(next.totals.itemCount);
  }, []);

  const request = useCallback(
    async (input: string, init?: RequestInit): Promise<Cart | null> => {
      setBusy(true);
      setError(null);
      try {
        const response = await fetch(input, {
          ...init,
          headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
        });
        const payload = await response.json().catch(() => null);

        if (!response.ok) {
          setError(payload?.error?.message ?? 'Could not update your cart. Please try again.');
          return null;
        }

        applyCart(payload.cart as Cart);
        // Server components (order summaries, stock badges) need to re-read.
        startTransition(() => router.refresh());
        return payload.cart as Cart;
      } catch {
        setError('Could not reach ShopiQ. Check your connection and try again.');
        return null;
      } finally {
        setBusy(false);
      }
    },
    [applyCart, router],
  );

  const addItem = useCallback(
    async (productId: string, quantity = 1) => {
      const next = await request('/api/cart/items', {
        method: 'POST',
        body: JSON.stringify({ productId, quantity }),
      });
      return next !== null;
    },
    [request],
  );

  const updateItem = useCallback(
    async (itemId: string, quantity: number) => {
      await request(`/api/cart/items/${itemId}`, {
        method: 'PATCH',
        body: JSON.stringify({ quantity }),
      });
    },
    [request],
  );

  const removeItem = useCallback(
    async (itemId: string) => {
      await request(`/api/cart/items/${itemId}`, { method: 'DELETE' });
    },
    [request],
  );

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/cart', { cache: 'no-store' });
      if (!response.ok) return;
      const payload = await response.json();
      applyCart(payload.cart as Cart);
    } catch {
      // A failed background refresh is not worth surfacing.
    }
  }, [applyCart]);

  const value = useMemo<CartState>(
    () => ({
      cart,
      itemCount: count,
      pending: busy || isPending,
      error,
      addItem,
      updateItem,
      removeItem,
      clearError: () => setError(null),
      refresh,
    }),
    [cart, count, busy, isPending, error, addItem, updateItem, removeItem, refresh],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartState {
  const value = useContext(CartContext);
  if (!value) {
    throw new Error('useCart must be used inside <CartProvider>.');
  }
  return value;
}
