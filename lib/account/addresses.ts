import 'server-only';
import { adminClient } from '@/lib/supabase/admin';
import { getSessionUser } from '@/lib/auth';
import { normalisePhone } from '@/lib/checkout/guest';

/**
 * Address book.
 *
 * Same rule as everything else that touches personal data: the customer id is
 * read from the session in here and is never a parameter. Every query is
 * scoped by it, so another customer's address id simply matches nothing rather
 * than being found and then rejected.
 */

export class NotSignedInError extends Error {
  constructor() {
    super('You need to sign in to manage your addresses.');
    this.name = 'NotSignedInError';
  }
}

async function requireCustomer(): Promise<string> {
  const user = await getSessionUser();
  if (!user) throw new NotSignedInError();
  return user.id;
}

export interface Address {
  id: string;
  label: string | null;
  fullName: string;
  phone: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  isDefault: boolean;
}

export interface AddressInput {
  label?: string | null;
  fullName: string;
  phone: string;
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  postalCode: string;
  country?: string | null;
  isDefault?: boolean;
}

function toAddress(row: Record<string, any>): Address {
  return {
    id: row.id,
    label: row.label ?? null,
    fullName: row.full_name,
    phone: row.phone,
    line1: row.line1,
    line2: row.line2 ?? null,
    city: row.city,
    state: row.state,
    postalCode: row.postal_code,
    country: row.country,
    isDefault: row.is_default,
  };
}

export interface ValidationFailure {
  field: string;
  message: string;
}

/** Validate and normalise. Returns the cleaned row, or the reasons it failed. */
function clean(input: AddressInput): { ok: true; row: Record<string, unknown> } | { ok: false; errors: ValidationFailure[] } {
  const errors: ValidationFailure[] = [];

  const fullName = input.fullName?.trim() ?? '';
  if (fullName.length < 2) errors.push({ field: 'fullName', message: 'Enter the recipient’s name.' });

  const phone = normalisePhone(input.phone ?? '');
  if (!phone) errors.push({ field: 'phone', message: 'Enter a 10-digit mobile number.' });

  const line1 = input.line1?.trim() ?? '';
  if (!line1) errors.push({ field: 'line1', message: 'Enter the house or flat and street.' });

  const city = input.city?.trim() ?? '';
  if (!city) errors.push({ field: 'city', message: 'Enter the city.' });

  const state = input.state?.trim() ?? '';
  if (!state) errors.push({ field: 'state', message: 'Enter the state.' });

  const postalCode = (input.postalCode ?? '').replace(/\s/g, '');
  // Indian PIN codes are six digits and never start with zero.
  if (!/^[1-9]\d{5}$/.test(postalCode)) {
    errors.push({ field: 'postalCode', message: 'Enter a valid 6-digit PIN code.' });
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    row: {
      label: input.label?.trim().slice(0, 40) || null,
      full_name: fullName.slice(0, 120),
      phone: phone!,
      line1: line1.slice(0, 200),
      line2: input.line2?.trim().slice(0, 200) || null,
      city: city.slice(0, 100),
      state: state.slice(0, 100),
      postal_code: postalCode,
      country: input.country?.trim().slice(0, 60) || 'India',
    },
  };
}

export async function listAddresses(): Promise<Address[]> {
  const customerId = await requireCustomer();
  const { data } = await adminClient()
    .from('customer_addresses')
    .select('*')
    .eq('customer_id', customerId)
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: false });
  return (data ?? []).map(toAddress);
}

/** Clear every other default. One address is the default, or none is. */
async function demoteOthers(customerId: string, keepId?: string): Promise<void> {
  const db = adminClient();
  let query = db
    .from('customer_addresses')
    .update({ is_default: false, updated_at: new Date().toISOString() })
    .eq('customer_id', customerId)
    .eq('is_default', true);
  if (keepId) query = query.neq('id', keepId);
  await query;
}

export async function addAddress(
  input: AddressInput,
): Promise<{ ok: true; address: Address } | { ok: false; errors: ValidationFailure[] }> {
  const customerId = await requireCustomer();
  const cleaned = clean(input);
  if (!cleaned.ok) return cleaned;

  const db = adminClient();
  const { count } = await db
    .from('customer_addresses')
    .select('*', { count: 'exact', head: true })
    .eq('customer_id', customerId);

  // The first address is always the default — a customer with exactly one
  // address and no default is a checkout that cannot find where to deliver.
  const isDefault = input.isDefault === true || (count ?? 0) === 0;
  if (isDefault) await demoteOthers(customerId);

  const { data, error } = await db
    .from('customer_addresses')
    .insert({ ...cleaned.row, customer_id: customerId, is_default: isDefault })
    .select('*')
    .single();

  if (error) throw error;
  return { ok: true, address: toAddress(data) };
}

export async function updateAddress(
  id: string,
  input: AddressInput,
): Promise<{ ok: true; address: Address } | { ok: false; errors: ValidationFailure[] } | null> {
  const customerId = await requireCustomer();
  const cleaned = clean(input);
  if (!cleaned.ok) return cleaned;

  const db = adminClient();
  if (input.isDefault === true) await demoteOthers(customerId, id);

  const { data, error } = await db
    .from('customer_addresses')
    .update({
      ...cleaned.row,
      ...(input.isDefault === undefined ? {} : { is_default: input.isDefault }),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    // Scoped to the owner: someone else's id updates zero rows.
    .eq('customer_id', customerId)
    .select('*')
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  return { ok: true, address: toAddress(data) };
}

export async function deleteAddress(id: string): Promise<boolean> {
  const customerId = await requireCustomer();
  const db = adminClient();

  const { data: existing } = await db
    .from('customer_addresses')
    .select('id, is_default')
    .eq('id', id)
    .eq('customer_id', customerId)
    .maybeSingle();
  if (!existing) return false;

  await db.from('customer_addresses').delete().eq('id', id).eq('customer_id', customerId);

  // Deleting the default promotes the next one rather than leaving the
  // customer with addresses but nowhere to deliver by default.
  if (existing.is_default) {
    const { data: next } = await db
      .from('customer_addresses')
      .select('id')
      .eq('customer_id', customerId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (next) {
      await db.from('customer_addresses').update({ is_default: true }).eq('id', next.id);
    }
  }
  return true;
}

export async function setDefaultAddress(id: string): Promise<boolean> {
  const customerId = await requireCustomer();
  const db = adminClient();

  const { data: existing } = await db
    .from('customer_addresses')
    .select('id')
    .eq('id', id)
    .eq('customer_id', customerId)
    .maybeSingle();
  if (!existing) return false;

  await demoteOthers(customerId, id);
  await db
    .from('customer_addresses')
    .update({ is_default: true, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('customer_id', customerId);
  return true;
}
