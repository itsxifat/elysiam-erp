import { Injectable } from '@nestjs/common';

import { ScannerService } from './scanner.service.js';

/**
 * What another module may ask packing (invariant 12; M35b, D-554): the identity module, having
 * checked a person's password and second factor, asks for a scanner device for them.
 */
export interface PackingApi {
  /** A new scanner device for this person in this brand; the token, shown once. */
  issueDevice(input: {
    readonly orgId: string;
    readonly userId: string;
    readonly label: string;
  }): Promise<{
    readonly token: string;
    readonly device: { readonly id: string; readonly expiresAt: string | null };
  }>;
}

export const PACKING_API = Symbol('PackingApi');

@Injectable()
export class PackingApiService implements PackingApi {
  constructor(private readonly scanner: ScannerService) {}

  async issueDevice(input: {
    readonly orgId: string;
    readonly userId: string;
    readonly label: string;
  }) {
    const { token, device } = await this.scanner.issue({
      ...input,
      via: 'password',
      actorUserId: input.userId,
    });
    return { token, device: { id: device.id, expiresAt: device.expiresAt } };
  }
}
