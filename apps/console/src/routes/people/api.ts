import type {
  BuyerCandidateView,
  CustomerAddressInput,
  CustomerAddressView,
  CustomerDetailsInput,
  CustomerGender,
  CustomerPhoneAddInput,
  CustomerPhoneRetireInput,
  CustomerPhoneUpdateInput,
  CustomerPhoneView,
} from '@elysium/contracts/customers';

import { api } from '../../api.js';

/**
 * M48's calls (D-870 to D-886): a buyer's numbers, merging two records, an order's buyer and the
 * desk's lookup with everyone a number names. Typed by the contracts the server validates with.
 */

export type { BuyerCandidateView, CustomerAddressView, CustomerPhoneView };

export const PHONE_KINDS = ['mobile', 'whatsapp', 'home', 'office', 'shop', 'other'] as const;
export const PHONE_RELATIONS = [
  'own',
  'household',
  'relative',
  'work',
  'someone_else',
  'other',
] as const;
export const RETIRE_REASONS = ['changed_number', 'wrong_number', 'not_theirs', 'other'] as const;

export const GENDERS = ['female', 'male', 'other'] as const satisfies readonly CustomerGender[];

/** A buyer as `GET /v1/customers/:id` returns them, with their numbers and address book. */
export interface PersonDetail {
  readonly id: string;
  readonly name: string;
  readonly phone: string;
  /** M49 (D-893). */
  readonly email: string | null;
  readonly gender: string | null;
  readonly ageBand: string | null;
  readonly profession: string | null;
  readonly birthday: string | null;
  readonly anniversary: string | null;
  readonly tags: readonly string[];
  readonly notes: string | null;
  readonly mergedIntoCustomerId: string | null;
  readonly phones: readonly CustomerPhoneView[];
  /** M49 (D-894): the address book, the default first. */
  readonly addresses: readonly CustomerAddressView[];
}

const path = (id: string) => `/v1/customers/${encodeURIComponent(id)}`;

export const getPerson = (id: string) => api.get<PersonDetail>(path(id));

export const addPhone = (id: string, body: CustomerPhoneAddInput) =>
  api.post<{ phones: CustomerPhoneView[] }>(`${path(id)}/phones`, body);

export const updatePhone = (id: string, phoneId: string, body: CustomerPhoneUpdateInput) =>
  api.patch<{ phones: CustomerPhoneView[] }>(
    `${path(id)}/phones/${encodeURIComponent(phoneId)}`,
    body,
  );

export const retirePhone = (id: string, phoneId: string, body: CustomerPhoneRetireInput) =>
  api.post<{ phones: CustomerPhoneView[] }>(
    `${path(id)}/phones/${encodeURIComponent(phoneId)}/retire`,
    body,
  );

/** M49 (D-891): the buyer's details; a field left out is kept, `null` clears it. */
export const updatePerson = (id: string, body: CustomerDetailsInput) =>
  api.patch<unknown>(path(id), body);

/** M49 (D-894): the address book. */
export const addAddress = (id: string, body: CustomerAddressInput) =>
  api.post<{ addresses: CustomerAddressView[] }>(`${path(id)}/addresses`, body);
export const replaceAddress = (id: string, addressId: string, body: CustomerAddressInput) =>
  api.put<{ addresses: CustomerAddressView[] }>(
    `${path(id)}/addresses/${encodeURIComponent(addressId)}`,
    body,
  );
export const removeAddress = (id: string, addressId: string) =>
  api.delete<{ addresses: CustomerAddressView[] }>(
    `${path(id)}/addresses/${encodeURIComponent(addressId)}`,
  );

export const mergePerson = (keptId: string, otherCustomerId: string, reason: string) =>
  api.post<{ keptId: string; mergedId: string; ordersMoved: number }>(`${path(keptId)}/merge`, {
    otherCustomerId,
    reason,
  });

/** Everyone a number names that the caller may open, the suggested one first (D-875). */
export const peopleOnNumber = (phone: string) =>
  api.get<{ phone: string; candidates?: readonly BuyerCandidateView[] }>(
    `/v1/customers/lookup?${new URLSearchParams({ phone }).toString()}`,
  );

export const changeOrderBuyer = (orderId: string, customerId: string, reason: string) =>
  api.post<{ orderId: string; customerId: string; changed: boolean }>(
    `/v1/orders/${encodeURIComponent(orderId)}/buyer`,
    { customerId, reason },
  );

export const buyerChecked = (orderId: string) =>
  api.post<{ orderId: string }>(`/v1/orders/${encodeURIComponent(orderId)}/buyer-checked`, {});

/** The supervisors (D-886): org_admin, branch_manager, a super admin. */
export function isSupervisor(roles: readonly string[], isSuperAdmin: boolean): boolean {
  return isSuperAdmin || roles.includes('org_admin') || roles.includes('branch_manager');
}

/** An E.164 Bangladeshi mobile as people read it, `01712-345678`; anything else as it is. */
export function nationalPhone(e164: string): string {
  if (!/^\+8801\d{9}$/.test(e164)) return e164;
  const national = `0${e164.slice(4)}`;
  return `${national.slice(0, 5)}-${national.slice(5)}`;
}

/** A Bangladeshi mobile as typed, in E.164, or null (the server decides; this only gates Save). */
export function typedMobile(input: string): string | null {
  const digits = input.replace(/[\s\-()]/g, '');
  const national = digits.startsWith('+880')
    ? `0${digits.slice(4)}`
    : digits.startsWith('880')
      ? `0${digits.slice(3)}`
      : digits;
  return /^01[13-9]\d{8}$/.test(national) ? `+88${national}` : null;
}
