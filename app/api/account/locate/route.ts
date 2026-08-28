import { z } from 'zod';

import { badRequest, jsonOk, unauthorized, withErrorHandling } from '@/lib/api/response';
import { getSessionUser } from '@/lib/auth';
import { reverseGeocode } from '@/lib/geo/reverse';
import { checkRateLimit } from '@/lib/ai/rate-limit';

/**
 * POST /api/account/locate
 *
 * Coordinates in, a fillable delivery address out.
 *
 * The browser has already asked the customer for permission by the time this
 * is called — this route never initiates anything. Coordinates are used for
 * the lookup and returned so the form can show where the pin landed; nothing
 * is stored here. The address is only persisted if the customer then saves it,
 * through the normal address endpoint with its normal validation.
 *
 * Geocoding is a CONVENIENCE. Every failure path returns a plain reason rather
 * than an error, because the fallback is simply typing the address in, and a
 * failed lookup must never be the thing that stops someone checking out.
 */
export const runtime = 'nodejs';
export const maxDuration = 30;

const bodySchema = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
  })
  .strict();

export const POST = withErrorHandling(async (request: Request) => {
  const user = await getSessionUser();
  if (!user) throw unauthorized('Sign in to use your location.');

  // Nominatim asks for low request rates, and honouring that is the condition
  // of using it without a key. This also stops a stuck client from hammering
  // a third party on our behalf.
  const limit = checkRateLimit(`locate:${user.id}`, { limit: 10, windowMs: 60_000 });
  if (!limit.allowed) {
    return jsonOk({
      ok: false,
      reason: 'rate_limited',
      message: 'Give it a moment and try again, or type the address in.',
    });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw badRequest('Expected a JSON body.');
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest('Latitude and longitude are required.');
  }

  const result = await reverseGeocode(parsed.data.latitude, parsed.data.longitude);

  if (!result.ok || !result.address) {
    return jsonOk({
      ok: false,
      reason: result.reason ?? 'not_found',
      message:
        result.reason === 'unreachable'
          ? "I couldn't reach the map service just now — please type the address in."
          : "I couldn't work out an address from that position — please type it in.",
    });
  }

  return jsonOk({
    ok: true,
    address: result.address,
    latitude: parsed.data.latitude,
    longitude: parsed.data.longitude,
  });
});
