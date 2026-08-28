import type { Metadata } from 'next';
import { AgentExperience } from '@/components/agent/AgentExperience';

export const metadata: Metadata = {
  title: 'ShopiQ — just talk',
  description:
    'Tell ShopiQ what you need. It finds it, compares it, and checks you out. No account required.',
};

/**
 * ShopiQ's front door IS the agent.
 *
 * There is no storefront landing page, no product grid and no navigation: the
 * customer arrives at something that listens. The catalogue routes still exist
 * for order links and the merchant panel, but nothing on the customer path
 * points at them — shopping happens through the conversation.
 *
 * Deliberately outside the `(storefront)` route group so it inherits none of
 * that shell.
 */
export default function HomePage() {
  return <AgentExperience />;
}
