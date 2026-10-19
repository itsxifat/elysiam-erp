import type {
  CustomerAddressInput,
  CustomerDetailsInput,
  CustomerPhoneAddInput,
  CustomerPhoneRetireInput,
  CustomerPhoneUpdateInput,
} from '@elysium/contracts/customers';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

import {
  addAddress,
  addPhone,
  removeAddress,
  replaceAddress,
  retirePhone,
  updatePerson,
  updatePhone,
} from './api.js';

/**
 * What a screen may do to a buyer (M49, D-890): one shape for the buyer page, which calls the
 * customer routes under the buyer's reach, and the inbox's customer card, which calls the
 * conversation's routes with the go-ahead on someone else's chat. The Numbers card, the details
 * and the address book take one of these, so both screens share their forms and their rules.
 *
 * Each call resolves once the write is done and what shows the buyer is refreshed. On someone
 * else's conversation the inbox asks first and resolves at once; the write follows the yes.
 */
export interface PersonActions {
  readonly updateDetails: (body: CustomerDetailsInput) => Promise<void>;
  readonly addPhone: (body: CustomerPhoneAddInput) => Promise<void>;
  readonly updatePhone: (phoneId: string, body: CustomerPhoneUpdateInput) => Promise<void>;
  readonly retirePhone: (phoneId: string, body: CustomerPhoneRetireInput) => Promise<void>;
  readonly addAddress: (body: CustomerAddressInput) => Promise<void>;
  readonly replaceAddress: (addressId: string, body: CustomerAddressInput) => Promise<void>;
  readonly removeAddress: (addressId: string) => Promise<void>;
}

/** The buyer page's actions: the customer routes, then the person and the lists refreshed. */
export function usePageActions(customerId: string): PersonActions {
  const queryClient = useQueryClient();
  return useMemo(() => {
    const after = async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['people', customerId] }),
        queryClient.invalidateQueries({ queryKey: ['customers'] }),
      ]);
    };
    const then =
      <A extends unknown[]>(call: (...args: A) => Promise<unknown>) =>
      async (...args: A) => {
        await call(...args);
        await after();
      };
    return {
      updateDetails: then((body: CustomerDetailsInput) => updatePerson(customerId, body)),
      addPhone: then((body: CustomerPhoneAddInput) => addPhone(customerId, body)),
      updatePhone: then((phoneId: string, body: CustomerPhoneUpdateInput) =>
        updatePhone(customerId, phoneId, body),
      ),
      retirePhone: then((phoneId: string, body: CustomerPhoneRetireInput) =>
        retirePhone(customerId, phoneId, body),
      ),
      addAddress: then((body: CustomerAddressInput) => addAddress(customerId, body)),
      replaceAddress: then((addressId: string, body: CustomerAddressInput) =>
        replaceAddress(customerId, addressId, body),
      ),
      removeAddress: then((addressId: string) => removeAddress(customerId, addressId)),
    };
  }, [customerId, queryClient]);
}
