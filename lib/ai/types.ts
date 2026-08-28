/**
 * Phase 2 AI domain types.
 *
 * These are the contract between the agent, the tool layer and the UI. Nothing
 * here is provider-specific — swapping Claude for Sarvam changes only the
 * files under lib/ai/provider/.
 */

import type { ReplyLanguage } from './language';
import type { ProductSummary } from '@/types';

// ---------------------------------------------------------------- requirements

/** A budget the shopper stated. `max` is a hard constraint; `min` rarely is. */
export interface Budget {
  min: number | null;
  max: number | null;
  currency: 'INR';
}

export type UseCase =
  | 'programming'
  | 'gaming'
  | 'college'
  | 'office'
  | 'travel'
  | 'gym'
  | 'photography'
  | 'video_editing'
  | 'music'
  | 'commute'
  | 'casual';

export type PreferenceKey =
  | 'portability'
  | 'performance'
  | 'battery_life'
  | 'camera'
  | 'noise_cancellation'
  | 'comfort'
  | 'display'
  | 'build_quality'
  | 'value';

/** low / high — the direction the shopper leans, not a measured value. */
export type PreferenceWeight = 'low' | 'high';

/**
 * A machine-checkable constraint derived from what the shopper said.
 * "nothing heavier than 2kg" becomes { key: 'weight_kg', op: 'lte', value: 2 }.
 */
export interface SpecConstraint {
  key: string;
  op: 'gte' | 'lte' | 'eq' | 'contains';
  value: string | number;
  /** Hard constraints filter; soft ones only influence the score. */
  hard: boolean;
  /** Verbatim-ish phrase that produced this, for explanations. */
  source?: string;
}

/**
 * The structured state the agent carries across turns. This — not the raw
 * transcript — is what "show me lighter ones" is resolved against.
 */
export interface ShoppingRequirements {
  category: string | null;
  categorySlug: string | null;
  budget: Budget;
  useCases: UseCase[];
  preferences: Partial<Record<PreferenceKey, PreferenceWeight>>;
  brands: string[];
  specConstraints: SpecConstraint[];
  /** Free-text search terms kept for full-text relevance. */
  keywords: string[];
  requireInStock: boolean;
  minRating: number | null;
  /**
   * The language replies are being written in. Persisted so an explicit
   * "hindi mein baat karo" survives a following "haan" — a one-word answer
   * carries no language evidence of its own.
   */
  language: ReplyLanguage;
}

export function emptyRequirements(): ShoppingRequirements {
  return {
    category: null,
    categorySlug: null,
    budget: { min: null, max: null, currency: 'INR' },
    useCases: [],
    preferences: {},
    brands: [],
    specConstraints: [],
    keywords: [],
    requireInStock: false,
    minRating: null,
    language: 'en',
  };
}

// --------------------------------------------------------------- recommendation

export interface ScoreBreakdown {
  budget: number;
  useCase: number;
  specification: number;
  preference: number;
  rating: number;
}

export interface Recommendation {
  product: ProductSummary;
  /** 0–100, deterministic. Never produced by the model. */
  score: number;
  breakdown: ScoreBreakdown;
  /** Facts, each traceable to a database value. */
  matchReasons: string[];
  /** Honest caveats — over budget, heavier than asked, low stock. */
  limitations: string[];
}

export type RecommendationOutcome =
  | { kind: 'matches'; recommendations: Recommendation[]; considered: number }
  /** Nothing satisfied the hard constraints, but we found near misses. */
  | {
      kind: 'relaxed';
      recommendations: Recommendation[];
      considered: number;
      relaxed: string[];
    }
  | { kind: 'empty'; considered: 0 };

// ------------------------------------------------------------------ agent I/O

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system';

export interface ConversationMessage {
  id: string;
  role: MessageRole;
  content: string;
  metadata: AssistantMetadata | Record<string, unknown>;
  createdAt: string;
}

/** What an assistant turn carries alongside its prose, for the UI to render. */
export interface AssistantMetadata {
  products?: RecommendedProductPayload[];
  comparison?: ComparisonPayload | null;
  actions?: AgentAction[];
  requirements?: ShoppingRequirements;
  intent?: AgentIntent;
  outcome?: AgentOutcome;
  toolsUsed?: string[];
  provider?: string;
  degraded?: boolean;
  /** Rendered as the cart card when a turn touched or read the cart. */
  cart?: AgentCartPayload | null;
  /** Rendered as the checkout summary card. */
  checkout?: AgentCheckoutPayload | null;
  /** A destructive action waiting for a yes. */
  pendingAction?: { action: string; summary: string } | null;
  /** An exact total awaiting the customer's explicit purchase approval. */
  purchase?: AgentPurchasePayload | null;
  /**
   * Only the internal payment id is kept on the transcript. The publishable
   * key, the provider order id and any signature are not conversation history.
   */
  paymentId?: string | null;
  /** Set after a verified payment produced an order. */
  order?: { id: string; orderNumber: string; totalDisplay: string } | null;
}

export type AgentOutcome =
  | 'matches'
  | 'relaxed'
  | 'empty'
  | 'answer'
  | 'clarify'
  | 'error'
  | 'cart_updated'
  | 'awaiting_confirmation'
  | 'cancelled'
  | 'checkout_ready'
  | 'checkout_blocked'
  // Phase 4. `awaiting_purchase_confirmation` is the exact total on the table
  // waiting for a yes; `payment_ready` means a provider order exists and the
  // customer must now complete it themselves.
  | 'awaiting_purchase_confirmation'
  | 'payment_ready'
  | 'payment_blocked'
  | 'payment_failed'
  | 'order_confirmed';

/**
 * A purchase confirmation on the table: the exact amount the customer is being
 * asked to approve, and when that offer stops being valid.
 */
export interface AgentPurchasePayload {
  confirmationId: string;
  status: 'pending' | 'confirmed' | 'expired' | 'invalidated' | 'consumed' | 'cancelled';
  amountMinor: number;
  amountDisplay: string;
  currency: string;
  expiresAt: string;
  items: Array<{
    productId: string;
    name: string;
    quantity: number;
    unitPriceMinor: number;
    lineTotalMinor: number;
  }>;
  subtotalMinor: number;
  shippingMinor: number;
}

/** What the browser needs to open the provider's checkout. Never a secret. */
export interface AgentPaymentPayload {
  paymentId: string;
  provider: string;
  publicKey: string | null;
  providerOrderId: string;
  amountMinor: number;
  amountDisplay: string;
  currency: string;
  customerName: string | null;
  customerEmail: string | null;
}

/** The cart shape the AI panel renders. Every figure is server-computed. */
export interface AgentCartLine {
  cartItemId: string;
  productId: string;
  /** Chosen options, e.g. { colour: 'Sage' }. Empty when none apply. */
  selectedOptions: Record<string, string>;
  name: string;
  brand: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  image: string | null;
  available: boolean;
  availableQuantity: number;
  priceChanged: boolean;
}

export interface AgentCartPayload {
  items: AgentCartLine[];
  subtotal: number;
  shipping: number;
  savings: number;
  total: number;
  currency: string;
  itemCount: number;
  issues: string[];
}

export interface AgentCheckoutChange {
  kind: string;
  productName: string;
  message: string;
}

export interface AgentCheckoutPayload {
  valid: boolean;
  items: AgentCartLine[];
  subtotal: number;
  shipping: number;
  savings: number;
  total: number;
  currency: string;
  itemCount: number;
  blockers: string[];
  changes: AgentCheckoutChange[];
  summary: string;
  checkoutUrl: string;
  /** Always false in Phase 3 — stated explicitly so the UI cannot assume. */
  createsOrder: false;
  createsPayment: false;
}

/** The product shape the AI panel renders. Facts come from the catalogue. */
export interface RecommendedProductPayload {
  productId: string;
  name: string;
  brand: string;
  slug: string;
  price: number;
  compareAtPrice: number | null;
  currency: string;
  rating: number;
  reviewCount: number;
  image: string | null;
  available: boolean;
  availableQuantity: number;
  lowStock: boolean;
  score: number;
  reason: string;
  matchReasons: string[];
  limitations: string[];
  keySpecs: Record<string, string | number>;
}

export interface ComparisonRow {
  key: string;
  label: string;
  /** One entry per product, aligned with `productIds`. */
  values: Array<string | number | null>;
  /** Index of the product that wins this row, or null when it is a tie. */
  winner: number | null;
  /** Whether a higher number is better; null for non-numeric rows. */
  higherIsBetter: boolean | null;
}

export interface ComparisonPayload {
  productIds: string[];
  products: RecommendedProductPayload[];
  rows: ComparisonRow[];
  /** Deterministic per-product summary, e.g. "wins on 4 of 9 attributes". */
  summary: string;
}

/**
 * Extensible action contract. Phase 3 added the cart and checkout members; the
 * union stays open so `pay` slots in for Phase 4 without a breaking change to
 * the frontend.
 */
export type AgentAction =
  | { type: 'compare'; productIds: string[] }
  | { type: 'view_product'; productId: string }
  | { type: 'refine'; suggestion: string }
  | { type: 'add_to_cart'; productId: string; label?: string }
  | { type: 'view_cart' }
  | { type: 'checkout' }
  | { type: 'confirm'; action: string; label: string }
  | { type: 'cancel'; action: string }
  // Phase 4 — the customer approving an exact amount, and then paying it.
  | { type: 'approve_purchase'; confirmationId: string; label: string; amountDisplay: string }
  | { type: 'decline_purchase'; confirmationId: string }
  | { type: 'open_payment' }
  | { type: 'view_order'; orderId: string }
  // Phase 8 — links into the customer's own account pages. These carry no id:
  // the page resolves the customer from the session, so a link can never be
  // pointed at somebody else's data.
  | { type: 'view_profile' }
  | { type: 'view_orders' }
  | { type: 'view_addresses' }
  | { type: 'add_address' }
  /** Choosing which saved address an order ships to. */
  | { type: 'select_address'; addressId: string; label: string };

export type AgentIntent =
  | 'recommend'
  | 'refine'
  | 'compare'
  | 'product_question'
  | 'availability'
  | 'browse_categories'
  | 'smalltalk'
  // Phase 3
  | 'cart_add'
  | 'cart_remove'
  | 'cart_update'
  | 'cart_clear'
  | 'cart_view'
  | 'cross_sell'
  | 'checkout'
  | 'confirm'
  // Phase 4
  | 'payment_status'
  | 'order_status'
  // Phase 8 — the customer's own account.
  //
  // These exist because without them every account request fell through to the
  // product classifier, where "change my phone number" searched the smartphone
  // category and "add a new address" offered to add a Galaxy S26. The tools
  // were registered the whole time; nothing routed to them.
  | 'profile_view'
  | 'profile_update'
  | 'address_list'
  | 'address_add'
  | 'order_list'
  | 'order_cancel'
  | 'order_support';

export interface AgentReply {
  message: string;
  products: RecommendedProductPayload[];
  comparison: ComparisonPayload | null;
  actions: AgentAction[];
  intent: AgentIntent;
  outcome: AgentOutcome;
  requirements: ShoppingRequirements;
  toolsUsed: string[];
  provider: string;
  /** True when the LLM was unavailable and deterministic fallbacks ran. */
  degraded: boolean;
  cart: AgentCartPayload | null;
  checkout: AgentCheckoutPayload | null;
  pendingAction: { action: string; summary: string } | null;
  /** Phase 4 — an exact total awaiting approval, and the resulting payment. */
  purchase?: AgentPurchasePayload | null;
  payment?: AgentPaymentPayload | null;
  order?: { id: string; orderNumber: string; totalDisplay: string } | null;
}
