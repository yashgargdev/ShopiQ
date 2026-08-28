import { z } from 'zod';
import { jsonOk, withErrorHandling, badRequest, unauthorized, notFound } from '@/lib/api/response';
import {
  addAddress,
  deleteAddress,
  listAddresses,
  setDefaultAddress,
  updateAddress,
  NotSignedInError,
} from '@/lib/account/addresses';

/**
 * The customer's address book.
 *
 * Every operation is scoped to the signed-in customer inside the service, so
 * an id belonging to somebody else matches nothing — the answer is "not
 * found", which is also all the caller is entitled to learn.
 */
const addressSchema = z
  .object({
    label: z.string().trim().max(40).nullish(),
    fullName: z.string().trim().min(1).max(120),
    phone: z.string().trim().min(1).max(30),
    line1: z.string().trim().min(1).max(200),
    line2: z.string().trim().max(200).nullish(),
    city: z.string().trim().min(1).max(100),
    state: z.string().trim().min(1).max(100),
    postalCode: z.string().trim().min(1).max(12),
    country: z.string().trim().max(60).nullish(),
    isDefault: z.boolean().nullish(),
  })
  .strict();

const patchSchema = z
  .object({
    id: z.string().uuid(),
    /** Make this the default without editing anything else. */
    makeDefault: z.literal(true).optional(),
    address: addressSchema.optional(),
  })
  .strict();

async function readBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw badRequest('Expected a JSON body.');
  }
}

/** Signed-out is a normal answer here, not a server fault. */
function rethrow(error: unknown): never {
  if (error instanceof NotSignedInError) throw unauthorized(error.message);
  throw error;
}

export const GET = withErrorHandling(async () => {
  try {
    return jsonOk(
      { addresses: await listAddresses() },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    rethrow(error);
  }
});

export const POST = withErrorHandling(async (request: Request) => {
  const parsed = addressSchema.safeParse(await readBody(request));
  if (!parsed.success) throw badRequest('Invalid address.', parsed.error.flatten());

  try {
    const result = await addAddress({
      ...parsed.data,
      label: parsed.data.label ?? null,
      line2: parsed.data.line2 ?? null,
      country: parsed.data.country ?? null,
      isDefault: parsed.data.isDefault ?? false,
    });
    if (!result.ok) {
      // Field-level messages, so the form can point at the offending input
      // rather than showing one generic failure.
      return jsonOk({ ok: false, errors: result.errors, addresses: await listAddresses() });
    }
    return jsonOk(
      { ok: true, address: result.address, addresses: await listAddresses() },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    rethrow(error);
  }
});

export const PATCH = withErrorHandling(async (request: Request) => {
  const parsed = patchSchema.safeParse(await readBody(request));
  if (!parsed.success) throw badRequest('Invalid address update.', parsed.error.flatten());

  try {
    if (parsed.data.makeDefault) {
      const ok = await setDefaultAddress(parsed.data.id);
      if (!ok) throw notFound('That address is no longer available.');
      return jsonOk(
        { ok: true, addresses: await listAddresses() },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }

    if (!parsed.data.address) throw badRequest('Nothing to update.');

    const result = await updateAddress(parsed.data.id, {
      ...parsed.data.address,
      label: parsed.data.address.label ?? null,
      line2: parsed.data.address.line2 ?? null,
      country: parsed.data.address.country ?? null,
      isDefault: parsed.data.address.isDefault ?? undefined,
    });

    if (result === null) throw notFound('That address is no longer available.');
    if (!result.ok) {
      return jsonOk({ ok: false, errors: result.errors, addresses: await listAddresses() });
    }
    return jsonOk(
      { ok: true, address: result.address, addresses: await listAddresses() },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    rethrow(error);
  }
});

export const DELETE = withErrorHandling(async (request: Request) => {
  const parsed = z.object({ id: z.string().uuid() }).strict().safeParse(await readBody(request));
  if (!parsed.success) throw badRequest('Invalid request.');

  try {
    const removed = await deleteAddress(parsed.data.id);
    if (!removed) throw notFound('That address is no longer available.');
    return jsonOk(
      { ok: true, addresses: await listAddresses() },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    rethrow(error);
  }
});
