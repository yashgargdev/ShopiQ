/**
 * Domain types shared by the API layer, the storefront and the merchant panel.
 *
 * Money is always a number in the smallest sensible unit for display (whole
 * rupees with paise as decimals) plus a currency code — never a formatted
 * string. The Phase 2 AI agent consumes these same shapes.
 */

export type CurrencyCode = 'INR';

export interface Availability {
  available: number;
  inStock: boolean;
  lowStock: boolean;
}

export interface CategoryRef {
  id: string;
  name: string;
  slug: string;
}

export interface Category extends CategoryRef {
  description: string | null;
  imageUrl: string | null;
  parentId: string | null;
  sortOrder: number;
  productCount?: number;
  children?: Category[];
}

/** Machine-readable specifications: numbers stay numbers. */
export type SpecValue = string | number;
export type SpecMap = Record<string, SpecValue>;

export interface ProductSpec {
  key: string;
  label: string;
  value: SpecValue;
  unit: string | null;
}

export interface ProductImage {
  id: string;
  url: string;
  alt: string | null;
  width: number | null;
  height: number | null;
  isPrimary: boolean;
  sortOrder: number;
  /** Credit for openly-licensed third-party photography. Null when first-party. */
  attribution: string | null;
  license: string | null;
  sourceUrl: string | null;
}

/** The card shape returned by list and search endpoints. */
export interface ProductSummary {
  id: string;
  name: string;
  slug: string;
  brand: string;
  sku: string;
  shortDescription: string | null;
  price: number;
  compareAtPrice: number | null;
  currency: CurrencyCode;
  rating: number;
  reviewCount: number;
  isFeatured: boolean;
  tags: string[];
  specs: SpecMap;
  /**
   * Catalogue knowledge for the recommendation engine — segments, use cases,
   * editorial performance scores and compatibility claims. Empty for products
   * imported before this existed, which the engine reads as "declares
   * nothing" rather than as a claim.
   */
  catalogMetadata?: Record<string, unknown>;
  category: CategoryRef;
  image: string | null;
  imageAlt: string | null;
  availability: Availability;
}

/** The full shape returned by GET /api/products/:id. */
export interface ProductDetail extends ProductSummary {
  description: string | null;
  images: ProductImage[];
  specifications: ProductSpec[];
  related: ProductSummary[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface ProductListResponse {
  products: ProductSummary[];
  pagination: Pagination;
}

export interface SearchResponse extends ProductListResponse {
  query: string;
}

export interface CatalogFacets {
  brands: Array<{ name: string; count: number }>;
  categories: Array<{ id: string; name: string; slug: string; count: number }>;
  priceRange: { min: number; max: number };
  total: number;
}

// ---------------------------------------------------------------------- cart

export interface CartLine {
  id: string;
  productId: string;
  name: string;
  slug: string;
  brand: string;
  image: string | null;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  compareAtPrice: number | null;
  currency: CurrencyCode;
  availability: Availability;
  /** True when the requested quantity exceeds what is actually on the shelf. */
  exceedsStock: boolean;
  /**
   * Catalogue price when this line was added. Used only to warn the shopper
   * that a price moved — the charge is always `unitPrice`, read live.
   */
  priceAtAdd: number | null;
  priceChanged: boolean;
  /**
   * Options the shopper chose for this line, e.g. { colour: 'Sage' }.
   *
   * Not inventory: every colour of a given storage size shares one SKU and one
   * stock figure, so this records a choice without implying a per-colour count
   * that no table holds.
   */
  selectedOptions: Record<string, string>;
}

/** What a cart mutation actually did, as opposed to what was asked for. */
export interface CartMutationOutcome {
  cartItemId: string | null;
  productName: string | null;
  /** Total quantity the caller asked the line to end up at. */
  requested: number;
  /** Total quantity the line actually ended up at. */
  applied: number;
  available: number;
  /** True when stock forced a smaller quantity than requested. */
  clamped: boolean;
  removed: boolean;
}

export interface CartMutationResult {
  cart: Cart;
  outcome: CartMutationOutcome;
}

export interface CartTotals {
  subtotal: number;
  savings: number;
  shipping: number;
  total: number;
  currency: CurrencyCode;
  itemCount: number;
}

export interface Cart {
  id: string;
  isGuest: boolean;
  items: CartLine[];
  totals: CartTotals;
  /** Set when a line cannot be fulfilled at its current quantity. */
  issues: string[];
}

// -------------------------------------------------------------------- orders

export type OrderStatus =
  | 'pending'
  | 'confirmed'
  | 'processing'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'refunded';

export type PaymentStatus = 'unpaid' | 'paid' | 'failed' | 'refunded';

export const ORDER_STATUSES: OrderStatus[] = [
  'pending',
  'confirmed',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
  'refunded',
];

export interface ShippingAddress {
  fullName: string;
  phone: string;
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

export interface OrderItem {
  id: string;
  productId: string | null;
  productName: string;
  productSlug: string | null;
  brand: string | null;
  sku: string | null;
  imageUrl: string | null;
  quantity: number;
  /** The price at the moment the order was placed, not today's price. */
  unitPrice: number;
  totalPrice: number;
}

export interface Order {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  paymentMethod: string;
  subtotal: number;
  discountAmount: number;
  shippingAmount: number;
  taxAmount: number;
  total: number;
  currency: CurrencyCode;
  shippingAddress: ShippingAddress;
  contactEmail: string;
  contactPhone: string | null;
  notes: string | null;
  items: OrderItem[];
  itemCount: number;
  placedAt: string;
  createdAt: string;
}

// ------------------------------------------------------------------ merchant

export interface InventoryRow {
  productId: string;
  name: string;
  slug: string;
  brand: string;
  sku: string;
  image: string | null;
  price: number;
  isActive: boolean;
  quantity: number;
  reservedQuantity: number;
  available: number;
  lowStockThreshold: number;
  status: 'out_of_stock' | 'low_stock' | 'healthy';
  updatedAt: string;
}

export interface DashboardStats {
  totalOrders: number;
  paidOrders: number;
  openOrders: number;
  cancelledOrders: number;
  totalRevenue: number;
  averageOrderValue: number;
  totalProducts: number;
  activeProducts: number;
  totalCategories: number;
  unitsOnHand: number;
  lowStockProducts: number;
  outOfStockProducts: number;
  recentRevenue: Array<{ day: string; revenue: number; orders: number }>;
  topProducts: Array<{ name: string; units: number; revenue: number }>;
}

export type MerchantRole = 'owner' | 'manager' | 'staff';

export interface SessionUser {
  id: string;
  email: string;
  fullName: string | null;
  isMerchant: boolean;
  merchantRole: MerchantRole | null;
}

// --------------------------------------------------------------- API errors

export type ApiErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVENTORY_CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
  };
}
