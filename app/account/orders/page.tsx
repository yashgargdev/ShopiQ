import type { Metadata } from 'next';
import { OrderManager } from '@/components/account/OrderManager';

export const metadata: Metadata = { title: 'My orders — ShopiQ' };

export default function OrdersPage() {
  return <OrderManager />;
}
