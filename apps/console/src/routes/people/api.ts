import type {
  BuyerCandidateView,
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

export type { BuyerCandidateView, CustomerPhoneView };

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

/** A buyer as `GET /v1/customers/:id` returns them, with their numbers. */
export interface PersonDetail {
  readonly id: string;
  readonly name: string;
  readonly phone: string;
  readonly mergedIntoCustomerId: string | null;
  readonly phones: readonly CustomerPhoneView[];
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
