import { jsonOk, withErrorHandling } from '@/lib/api/response';
import { providerStatus } from '@/lib/ai/provider';
import {
  MONEY_TOOL_NAMES,
  TOOL_NAMES,
  WRITE_TOOL_NAMES,
  toolMetadata,
} from '@/lib/ai/tools/registry';
import { paymentStatus } from '@/lib/payments';

/**
 * GET /api/ai/status
 *
 * Lets the UI show an honest state before the shopper types anything, and
 * gives the smoke tests something to assert against. Reports whether a model
 * is reachable and which tools exist — never the model id, base URL, or any
 * part of a credential.
 */
export const GET = withErrorHandling(async () => {
  const status = providerStatus();
  const payments = paymentStatus();

  return jsonOk(
    {
      /** True when an LLM is configured; false means deterministic mode. */
      aiEnabled: status.available,
      mode: status.available ? 'ai' : 'deterministic',
      tools: TOOL_NAMES,
      /** Tools that can change commerce state (Phase 3 added these). */
      writeTools: WRITE_TOOL_NAMES,
      /** The permission ladder, so a client never has to infer it. */
      toolLevels: Object.fromEntries(TOOL_NAMES.map((name) => [name, toolMetadata(name).level])),
      /** Tools that can start a charge. Exactly one. */
      moneyTools: MONEY_TOOL_NAMES,
      /** Tools that will not run without an explicit customer confirmation. */
      requiresConfirmation: TOOL_NAMES.filter(
        (name) => toolMetadata(name).requiresConfirmation,
      ),

      /**
       * Phase 4: the agent can now start a payment — but only one a customer
       * has explicitly approved, and it still cannot place an order directly.
       * An order exists only after a payment is verified server-side.
       */
      canPlaceOrders: false,
      /**
       * True since Phase 4: the assistant CAN start a payment — but only one
       * the customer has explicitly approved, at a server-computed total, for
       * an unchanged cart, within the confirmation window. The boundary is
       * `permissions` below, not the absence of the capability.
       */
      canTakePayment: true,
      /** Declared permission metadata, enforced by the backend (Phase 6 §11). */
      permissions: TOOL_NAMES.map((name) => {
        const meta = toolMetadata(name);
        return {
          name,
          level: meta.level,
          risk: meta.risk,
          requiresAuth: meta.requiresAuth,
          requiresConfirmation: meta.requiresConfirmation,
          mutates: meta.mutates,
        };
      }),
      /** A charge NEVER happens without a fresh, unexpired, cart-matched yes. */
      requiresExplicitPurchaseConfirmation: true,
      autonomousPurchasing: false,

      payments: {
        provider: payments.provider,
        configured: payments.provider !== 'none',
        /** True on a Razorpay test key, or on the deterministic mock. */
        testMode: payments.testMode,
        /** Never the secret — this is the publishable key id only. */
        publicKeyPresent: Boolean(payments.publicKey),
      },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
});
