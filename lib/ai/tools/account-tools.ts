import 'server-only';
import { ApiError } from '@/lib/api/response';
import {
  NotSignedInError,
  cancelOrder,
  getOrderByNumber,
  getProfile,
  listMyOrders,
  requestSupport,
  updateProfile,
} from './account';
import type {
  CancelOrderInput,
  GetOrderInput,
  GetProfileInput,
  ListMyOrdersInput,
  RequestSupportInput,
  UpdateProfileInput,
} from './schemas';

/**
 * Tool wrappers for the account and support services.
 *
 * These exist only to translate. The services own the rules — including the
 * one that matters most, that identity is read from the session and never from
 * an argument — and this layer turns their refusals into something the agent
 * can say out loud without leaking why.
 */

/** A signed-out caller gets an ordinary, actionable refusal. */
function toApiError(error: unknown): never {
  if (error instanceof NotSignedInError) {
    throw new ApiError('UNAUTHORIZED', error.message);
  }
  throw error;
}

export async function getProfileTool(_input: GetProfileInput) {
  try {
    return await getProfile();
  } catch (error) {
    toApiError(error);
  }
}

export async function updateProfileTool(input: UpdateProfileInput) {
  try {
    const result = await updateProfile({
      full_name: input.full_name ?? undefined,
      phone: input.phone ?? undefined,
      address: input.address
        ? {
            line1: input.address.line1,
            line2: input.address.line2 ?? null,
            city: input.address.city,
            state: input.address.state ?? null,
            postal_code: input.address.postal_code ?? null,
            country: input.address.country ?? null,
          }
        : undefined,
    });
    return {
      updated: result.updated,
      // Surfaced rather than swallowed: a phone number the server refused is
      // usually a mishearing, and the customer should be asked again.
      rejected: result.rejected,
      profile: result.profile,
    };
  } catch (error) {
    toApiError(error);
  }
}

export async function listMyOrdersTool(input: ListMyOrdersInput) {
  try {
    const orders = await listMyOrders(input.limit ?? 5);
    return { orders, count: orders.length };
  } catch (error) {
    toApiError(error);
  }
}

export async function getOrderTool(input: GetOrderInput) {
  try {
    const order = await getOrderByNumber(input.order_number);
    if (!order) {
      // Deliberately identical whether the order belongs to someone else or
      // does not exist. Distinguishing them would confirm that a stranger's
      // order number is real.
      throw new ApiError('NOT_FOUND', "I couldn't find that order on your account.");
    }
    return order;
  } catch (error) {
    toApiError(error);
  }
}

export async function cancelOrderTool(input: CancelOrderInput) {
  try {
    return await cancelOrder(input.order_number);
  } catch (error) {
    toApiError(error);
  }
}

export async function requestSupportTool(input: RequestSupportInput) {
  try {
    return await requestSupport(input.order_number, input.kind, input.reason);
  } catch (error) {
    toApiError(error);
  }
}
