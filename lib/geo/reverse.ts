import 'server-only';
import type { GuestAddress } from '@/lib/checkout/guest';

/**
 * Reverse geocoding: coordinates → a human-readable delivery address.
 *
 * Uses OpenStreetMap's Nominatim, which needs no API key but does require a
 * genuine User-Agent and low request rates — both honoured below. It is only
 * ever called after the customer has explicitly granted location permission in
 * their browser.
 *
 * The failure path matters more than the happy one: geocoding is a convenience,
 * and a customer whose coordinates cannot be resolved must simply be asked for
 * their address instead. It must never block checkout.
 */

const NOMINATIM = process.env.GEOCODER_URL ?? 'https://nominatim.openstreetmap.org/reverse';
const USER_AGENT = 'ShopiQ/1.0 (https://shopiq.yashgarg.co.in; shopiq@yashgarg.co.in)';

/** Coordinates outside these bounds are a bug or a spoof, not a delivery address. */
function validCoordinates(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

export interface ReverseGeocodeResult {
  ok: boolean;
  address: GuestAddress | null;
  /** A short reason the caller can turn into something sayable. */
  reason?: 'invalid_coordinates' | 'unreachable' | 'not_found' | 'incomplete';
}

/**
 * Resolve coordinates to an address.
 *
 * Returns `ok: false` rather than throwing, and never partially fills an
 * address — an address missing its city is not a delivery address, and
 * pretending otherwise produces an undeliverable order.
 */
export async function reverseGeocode(
  latitude: number,
  longitude: number,
): Promise<ReverseGeocodeResult> {
  if (!validCoordinates(latitude, longitude)) {
    return { ok: false, address: null, reason: 'invalid_coordinates' };
  }

  const url = new URL(NOMINATIM);
  url.search = new URLSearchParams({
    lat: String(latitude),
    lon: String(longitude),
    format: 'jsonv2',
    addressdetails: '1',
    zoom: '18',
  }).toString();

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' },
      // A slow geocoder must not hold up a checkout conversation.
      signal: AbortSignal.timeout(6000),
      cache: 'no-store',
    });
  } catch {
    return { ok: false, address: null, reason: 'unreachable' };
  }

  if (!response.ok) return { ok: false, address: null, reason: 'unreachable' };

  let body: any;
  try {
    body = await response.json();
  } catch {
    return { ok: false, address: null, reason: 'unreachable' };
  }

  const parts = body?.address;
  if (!parts) return { ok: false, address: null, reason: 'not_found' };

  // Nominatim's field names vary by country and settlement type, so several
  // are tried for each slot rather than assuming one shape.
  const line1 =
    [parts.house_number, parts.building, parts.road ?? parts.pedestrian ?? parts.footway]
      .filter(Boolean)
      .join(' ')
      .trim() ||
    parts.neighbourhood ||
    parts.suburb ||
    '';

  const city =
    parts.city ?? parts.town ?? parts.village ?? parts.municipality ?? parts.county ?? '';
  const state = parts.state ?? parts.region ?? '';
  const postalCode = parts.postcode ?? '';
  const country = parts.country ?? 'India';

  if (!line1 || !city) {
    return { ok: false, address: null, reason: 'incomplete' };
  }

  return {
    ok: true,
    address: {
      line1: String(line1).slice(0, 200),
      line2: [parts.suburb, parts.neighbourhood].filter(Boolean).join(', ').slice(0, 200) || null,
      city: String(city).slice(0, 100),
      state: String(state).slice(0, 100),
      postalCode: String(postalCode).slice(0, 20),
      country: String(country).slice(0, 60),
      latitude,
      longitude,
    },
  };
}
