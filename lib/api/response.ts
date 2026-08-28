import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

import { AuthError } from '@/lib/auth';
import type { ApiErrorCode, Pagination } from '@/types';

/**
 * One error shape for every endpoint, so both the storefront and the Phase 2
 * AI tool layer can branch on `error.code` instead of parsing prose.
 *
 * Nothing here ever forwards a database message to the client: Postgres errors
 * leak table names, constraint names and sometimes row values.
 */

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVENTORY_CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly details?: unknown;

  constructor(code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new ApiError('BAD_REQUEST', message, details);
export const notFound = (message = 'Not found') => new ApiError('NOT_FOUND', message);
export const unauthorized = (message = 'You must be signed in to do that.') =>
  new ApiError('UNAUTHORIZED', message);
export const forbidden = (message = 'You do not have access to this resource.') =>
  new ApiError('FORBIDDEN', message);
export const conflict = (message: string, details?: unknown) =>
  new ApiError('CONFLICT', message, details);
export const inventoryConflict = (message: string, details?: unknown) =>
  new ApiError('INVENTORY_CONFLICT', message, details);

export function jsonOk<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, init);
}

export function jsonError(code: ApiErrorCode, message: string, details?: unknown): NextResponse {
  return NextResponse.json({ error: { code, message, details } }, { status: STATUS_BY_CODE[code] });
}

/**
 * Wrap a route handler so every thrown error becomes a well-formed response.
 * Unexpected errors are logged server-side and reported as a generic 500.
 */
export function withErrorHandling<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (error) {
      return toErrorResponse(error);
    }
  };
}

export function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof ApiError) {
    return jsonError(error.code, error.message, error.details);
  }

  if (error instanceof AuthError) {
    return jsonError(error.code, error.message);
  }

  if (error instanceof ZodError) {
    return jsonError(
      'VALIDATION_ERROR',
      'The request did not pass validation.',
      error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
    );
  }

  console.error('[shopiq] unhandled API error:', error);
  return jsonError('INTERNAL_ERROR', 'Something went wrong on our side. Please try again.');
}

/**
 * Map errors raised by the Postgres functions onto API codes. The functions
 * signal with sentinel messages ("INSUFFICIENT_STOCK:name:available") rather
 * than SQLSTATE so the payload can carry context.
 */
export function mapDatabaseError(error: { message?: string } | null): ApiError | null {
  const message = error?.message ?? '';
  if (!message) return null;

  if (message.includes('AUTH_REQUIRED')) {
    return unauthorized();
  }
  if (message.includes('CART_EMPTY')) {
    return badRequest('Your cart is empty.');
  }
  if (message.includes('ORDER_NOT_FOUND')) {
    return notFound('Order not found.');
  }
  if (message.includes('INVENTORY_CONFLICT')) {
    return inventoryConflict('That stock change would leave inventory in an invalid state.');
  }
  if (message.includes('PRODUCT_UNAVAILABLE')) {
    const name = message.split('PRODUCT_UNAVAILABLE:')[1]?.split('\n')[0]?.trim();
    return conflict(
      name ? `${name} is no longer available.` : 'A product in your cart is no longer available.',
    );
  }
  if (message.includes('INSUFFICIENT_STOCK')) {
    const raw = message.split('INSUFFICIENT_STOCK:')[1]?.split('\n')[0] ?? '';
    const lastColon = raw.lastIndexOf(':');
    const name = lastColon > 0 ? raw.slice(0, lastColon).trim() : raw.trim();
    const available = lastColon > 0 ? Number(raw.slice(lastColon + 1)) : NaN;
    return inventoryConflict(
      Number.isFinite(available)
        ? `Only ${available} of ${name} ${available === 1 ? 'is' : 'are'} still in stock.`
        : 'One of the items in your cart just went out of stock.',
      Number.isFinite(available) ? { product: name, available } : undefined,
    );
  }
  return null;
}

export function buildPagination(page: number, limit: number, total: number): Pagination {
  const totalPages = limit > 0 ? Math.ceil(total / limit) : 0;
  return {
    page,
    limit,
    total,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
}
