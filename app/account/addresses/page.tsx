import type { Metadata } from 'next';
import { AddressBook } from '@/components/account/AddressBook';

export const metadata: Metadata = { title: 'Addresses — ShopiQ' };

export default function AddressesPage() {
  return <AddressBook />;
}
