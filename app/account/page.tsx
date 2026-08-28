import type { Metadata } from 'next';
import { ProfileEditor } from '@/components/account/ProfileEditor';

export const metadata: Metadata = { title: 'Profile — ShopiQ' };

export default function ProfilePage() {
  return <ProfileEditor />;
}
