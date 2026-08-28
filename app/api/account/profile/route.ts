import { z } from 'zod';
import { jsonOk, withErrorHandling, badRequest, unauthorized } from '@/lib/api/response';
import { getProfile, updateProfile, NotSignedInError } from '@/lib/ai/tools/account';

/**
 * The customer's own profile.
 *
 * Shares one service with the assistant's `get_profile` / `update_profile`
 * tools, so the page and the agent cannot drift apart on what a customer is
 * allowed to change. Email is not editable here either — it is the sign-in
 * credential, and changing it would be account takeover rather than an edit.
 */
const patchSchema = z
  .object({
    fullName: z.string().trim().max(120).nullish(),
    phone: z.string().trim().max(30).nullish(),
  })
  .strict();

export const GET = withErrorHandling(async () => {
  try {
    return jsonOk({ profile: await getProfile() }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof NotSignedInError) throw unauthorized(error.message);
    throw error;
  }
});

export const PATCH = withErrorHandling(async (request: Request) => {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw badRequest('Expected a JSON body.');
  }

  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) throw badRequest('Invalid profile update.', parsed.error.flatten());

  try {
    const result = await updateProfile({
      full_name: parsed.data.fullName ?? undefined,
      phone: parsed.data.phone ?? undefined,
    });
    return jsonOk(
      { updated: result.updated, rejected: result.rejected, profile: result.profile },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    if (error instanceof NotSignedInError) throw unauthorized(error.message);
    throw error;
  }
});
